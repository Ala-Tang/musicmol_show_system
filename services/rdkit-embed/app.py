"""
可选本地服务：SMILES → Python RDKit AddHs + EmbedMolecule(+ETKDG) + MMFF 轻优化 → molblock。
前端在配置 `RDKIT_EMBED_API_BASE` 时优先请求本服务，失败则回退 WASM（保持现有行为）。
"""
from __future__ import annotations

import os
import sys
import unicodedata
from io import StringIO
from collections import OrderedDict, namedtuple
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from rdkit import Chem
from rdkit.Chem import AllChem, Crippen, Descriptors, Lipinski, QED, rdmolops, rdMolDescriptors
from rdkit.Chem.rdchem import BondType

try:
    from .similar_drugs_fda import (
        query_topk_similar_drugs as fda_query_topk_similar_drugs,
        sample_random_molecules as fda_sample_random_molecules,
    )
except ImportError:  # 直接 `python app.py` 启动时无包名
    from similar_drugs_fda import (
        query_topk_similar_drugs as fda_query_topk_similar_drugs,
        sample_random_molecules as fda_sample_random_molecules,
    )

app = FastAPI(title="painojs RDKit embed", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class EmbedRequest(BaseModel):
    smiles: str = Field(..., min_length=1, max_length=4096)


class SimilarDrugsRequest(BaseModel):
    smiles: str = Field(..., min_length=1, max_length=4096)
    top_k: int = Field(5, ge=1, le=50)
    n_jobs: int = Field(12, ge=1, le=64)


class RandomMoleculesRequest(BaseModel):
    count: int = Field(16, ge=1, le=40)
    seed: int | None = Field(None, description="可选固定种子，便于复现")


def _convert_logs_to_mol_per_l(logs: float) -> float:
    return 10**logs


def _format_scientific_notation(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}e}"


def _get_molecular_weight_level(mw: float) -> str:
    if mw < 300:
        return "较小"
    if mw < 500:
        return "中等"
    return "较大"


def _get_logp_level(logp: float) -> str:
    if logp < 1:
        return "低"
    if logp < 3:
        return "中等"
    if logp < 5:
        return "较高"
    return "高"


def _get_elogs_level(elogs: float) -> str:
    if elogs > 0:
        return "极易溶"
    if elogs > -2:
        return "易溶"
    if elogs > -4:
        return "中等"
    if elogs > -6:
        return "难溶"
    return "几乎不溶"


def _get_qed_level(qed_v: float) -> str:
    if qed_v >= 0.67:
        return "高"
    if qed_v >= 0.49:
        return "中等"
    return "低"


def _get_complexity_level(bertz: float) -> str:
    if bertz < 300:
        return "低"
    if bertz < 700:
        return "中等"
    if bertz < 1200:
        return "较高"
    return "高"


def _get_chiral_center_level(n: int) -> str:
    if n == 0:
        return "无"
    if n <= 2:
        return "中等"
    return "高"


def _get_aromatic_ring_level(n: int) -> str:
    if n <= 1:
        return "少"
    if n <= 3:
        return "中等"
    return "多"


def _get_synthetic_accessibility(mol: Chem.Mol) -> dict[str, Any]:
    mw = Descriptors.MolWt(mol)
    ring_count = rdMolDescriptors.CalcNumRings(mol)
    spiro = rdMolDescriptors.CalcNumSpiroAtoms(mol)
    bridge = rdMolDescriptors.CalcNumBridgeheadAtoms(mol)
    chiral = len(Chem.FindMolChiralCenters(mol, includeUnassigned=True))
    rot = Lipinski.NumRotatableBonds(mol)

    score = 1.5
    score += 0.012 * max(mw - 250, 0)
    score += 0.35 * ring_count
    score += 1.2 * spiro
    score += 1.0 * bridge
    score += 0.5 * chiral
    score += 0.15 * rot
    score = min(score, 10.0)

    if score < 3:
        level = "简单"
    elif score < 5:
        level = "中等"
    elif score < 7:
        level = "困难"
    else:
        level = "较难合成"
    return {"value": round(score, 2), "level": level}


def _get_toxicity_warnings(mol: Chem.Mol, logp: float) -> dict[str, Any]:
    mw = Descriptors.MolWt(mol)
    aromatic_rings = rdMolDescriptors.CalcNumAromaticRings(mol)
    alerts = {
        "硝基": Chem.MolFromSmarts("[NX3](=O)=O"),
        "芳香胺": Chem.MolFromSmarts("c[NH2]"),
        "醛基": Chem.MolFromSmarts("[CX3H1](=O)[#6]"),
        "环氧基": Chem.MolFromSmarts("C1OC1"),
        "Michael受体": Chem.MolFromSmarts("[C,c]=[C,c]-[C](=O)[O,N,S]"),
    }
    hit_alerts = [name for name, patt in alerts.items() if patt is not None and mol.HasSubstructMatch(patt)]
    has_basic_amine = mol.HasSubstructMatch(Chem.MolFromSmarts("[NX3;H0,H1,H2;!$(N=*)]"))

    herg_score = 0
    if has_basic_amine:
        herg_score += 1
    if aromatic_rings >= 2:
        herg_score += 1
    if logp > 3:
        herg_score += 1
    if mw > 350:
        herg_score += 1
    herg_warning = "低" if herg_score <= 1 else ("中" if herg_score == 2 else "高")

    dili_score = 0
    if logp > 3:
        dili_score += 1
    if logp > 5:
        dili_score += 1
    if mw > 400:
        dili_score += 1
    if aromatic_rings >= 3:
        dili_score += 1
    if len(hit_alerts) >= 1:
        dili_score += 1
    dili_warning = "低" if dili_score <= 1 else ("中" if dili_score <= 3 else "高")

    ames_related = {"硝基", "芳香胺", "环氧基"}
    ames_hits = [x for x in hit_alerts if x in ames_related]
    ames_warning = "低" if len(ames_hits) == 0 else ("中" if len(ames_hits) == 1 else "高")

    carcinogenicity_score = 0
    if "硝基" in hit_alerts:
        carcinogenicity_score += 1
    if "芳香胺" in hit_alerts:
        carcinogenicity_score += 1
    if aromatic_rings >= 3:
        carcinogenicity_score += 1
    if logp > 4:
        carcinogenicity_score += 1
    carcinogenicity_warning = (
        "低" if carcinogenicity_score == 0 else ("中" if carcinogenicity_score <= 2 else "高")
    )

    risk_map = {"低": 0, "中": 1, "高": 2}
    overall_score = max(
        risk_map[herg_warning], risk_map[dili_warning], risk_map[ames_warning], risk_map[carcinogenicity_warning]
    )
    overall_warning = ["低", "中", "高"][overall_score]

    return {
        "cardiotoxicity": {"name": "心脏毒性预警", "value": herg_score, "level": herg_warning},
        "hepatotoxicity": {"name": "肝脏毒性预警", "value": dili_score, "level": dili_warning},
        "mutagenicity": {"name": "致突变预警", "value": len(ames_hits), "level": ames_warning},
        "carcinogenicity": {"name": "致癌性预警", "value": carcinogenicity_score, "level": carcinogenicity_warning},
        "overall": {"name": "总体风险预警", "value": overall_score, "level": overall_warning},
    }


class ELogSCalculator:
    def __init__(self) -> None:
        self.aromatic_query = Chem.MolFromSmarts("a")
        self.Descriptor = namedtuple("Descriptor", "mw logp rotors ap")

    def calc_aromatic_proportion(self, mol: Chem.Mol) -> float:
        matches = mol.GetSubstructMatches(self.aromatic_query)
        n_atoms = mol.GetNumAtoms()
        if n_atoms == 0:
            return 0.0
        return len(matches) / n_atoms

    def calc_descriptors(self, mol: Chem.Mol) -> Any:
        mw = Descriptors.MolWt(mol)
        logp = Crippen.MolLogP(mol)
        rotors = Lipinski.NumRotatableBonds(mol)
        ap = self.calc_aromatic_proportion(mol)
        return self.Descriptor(mw=mw, logp=logp, rotors=rotors, ap=ap)

    def predict(self, mol: Chem.Mol) -> float:
        intercept = 0.26121066137801696
        coef = {
            "mw": -0.0066138847738667125,
            "logp": -0.7416739523408995,
            "rotors": 0.003451545565957996,
            "ap": -0.42624840441316975,
        }
        desc = self.calc_descriptors(mol)
        logs = (
            intercept
            + coef["logp"] * desc.logp
            + coef["mw"] * desc.mw
            + coef["rotors"] * desc.rotors
            + coef["ap"] * desc.ap
        )
        return float(logs)


def get_molecule_display_properties(smiles: str) -> dict[str, Any]:
    mol = mol_from_smiles_embed(smiles)
    if mol is None:
        return {"valid": False, "input_smiles": smiles, "error": "Invalid SMILES"}

    canonical_smiles = Chem.MolToSmiles(mol)
    formula = rdMolDescriptors.CalcMolFormula(mol)
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    elogs = ELogSCalculator().predict(mol)
    solubility_mol_l = _convert_logs_to_mol_per_l(elogs)

    qed = QED.qed(mol)
    bertz = Descriptors.BertzCT(mol)
    chiral_centers = len(Chem.FindMolChiralCenters(mol, includeUnassigned=True))
    aromatic_rings = rdMolDescriptors.CalcNumAromaticRings(mol)
    sa_info = _get_synthetic_accessibility(mol)
    tox_info = _get_toxicity_warnings(mol, logp)
    return {
        "基本信息": [
            {"name": "分子式", "value": formula, "level": "基础信息"},
            {"name": "分子量（Da）", "value": round(mw, 2), "level": _get_molecular_weight_level(mw)},
            {"name": "SMILES", "value": canonical_smiles, "level": "结构表示"},
            {"name": "手性中心数", "value": chiral_centers, "level": _get_chiral_center_level(chiral_centers)},
            {"name": "芳香环数", "value": aromatic_rings, "level": _get_aromatic_ring_level(aromatic_rings)},
        ],
        "药化属性": [
            {"name": "脂溶性（LogP）", "value": round(logp, 2), "level": _get_logp_level(logp)},
            {
                "name": "水溶性（mol/L）",
                "value": _format_scientific_notation(solubility_mol_l, digits=2),
                "level": _get_elogs_level(elogs),
            },
            {"name": "类药性（QED）", "value": round(qed, 3), "level": _get_qed_level(qed)},
            {"name": "分子复杂度（BertzCT）", "value": round(bertz, 2), "level": _get_complexity_level(bertz)},
            {"name": "可合成性（SA Score）", "value": sa_info["value"], "level": sa_info["level"]},
        ],
        "毒性预警": [
            {"name": "肝脏毒性预警", "value": tox_info["hepatotoxicity"]["value"], "level": tox_info["hepatotoxicity"]["level"]},
            {"name": "心脏毒性预警", "value": tox_info["cardiotoxicity"]["value"], "level": tox_info["cardiotoxicity"]["level"]},
            {"name": "致突变预警", "value": tox_info["mutagenicity"]["value"], "level": tox_info["mutagenicity"]["level"]},
            {"name": "致癌性预警", "value": tox_info["carcinogenicity"]["value"], "level": tox_info["carcinogenicity"]["level"]},
            {"name": "总体风险预警", "value": tox_info["overall"]["value"], "level": tox_info["overall"]["level"]},
        ],
    }


def bond_orders_for_pdb(mol: Chem.Mol) -> list[list[int]]:
    """
    与 MolToPDBBlock(mol) 中 ATOM/HETATM 行顺序一致的 0-based 原子下标 + RDKit 键级（GetBondType）。
    标准 PDB CONECT 不含键级，前端 PDBLoader 也一律写成单键；用本字段恢复单/双/三/芳香等。
    前端球棍：1=单，2=双，3=三，4=芳香（与 molblock/V2000 惯例一致；ONEANDAHALF→4；2.5/3.5 等不按芳香）。
    """
    out: list[list[int]] = []
    for b in mol.GetBonds():
        i = int(b.GetBeginAtomIdx())
        j = int(b.GetEndAtomIdx())
        if i > j:
            i, j = j, i
        bt = b.GetBondType()
        if bt == BondType.SINGLE:
            o = 1
        elif bt == BondType.DOUBLE:
            o = 2
        elif bt == BondType.TRIPLE:
            o = 3
        elif bt == BondType.AROMATIC:
            o = 4
        elif bt == BondType.ONEANDAHALF:
            o = 4
        elif bt == BondType.TWOANDAHALF:
            o = 3
        elif bt == BondType.THREEANDAHALF:
            o = 3
        elif bt == BondType.QUADRUPLE:
            o = 3
        elif bt in (BondType.DATIVE, BondType.ZERO) or (
            hasattr(BondType, "IONIC") and bt == BondType.IONIC
        ):
            o = 1
        else:
            o = 1
        out.append([i, j, o])
    return out






def atom_styles_for_pdb(mol: Chem.Mol) -> list[list[Any]]:
    """与 PDB 原子序一致：返回 [idx, symbol, atomic_num, covalent_radius, vdw_radius, color_hex]。"""
    pt = Chem.GetPeriodicTable()
    # 与 RDKit MolDraw 默认调色板对齐的常用元素色（碳为灰 #909090，非旧版 CPK 黑）
    cpk: dict[int, str] = {
        1: "#FFFFFF", 6: "#909090", 7: "#3050F8", 8: "#FF0D0D", 9: "#90E050",
        15: "#FF8000", 16: "#FFFF30", 17: "#1FF01F", 35: "#A62929", 53: "#940094",
    }
    out: list[list[Any]] = []
    for a in mol.GetAtoms():
        idx = int(a.GetIdx())
        z = int(a.GetAtomicNum())
        sym = str(a.GetSymbol())
        cov = float(pt.GetRcovalent(z)) if z > 0 else 0.77
        vdw = float(pt.GetRvdw(z)) if z > 0 else 1.7
        color = cpk.get(z, "#B8BEC8")
        out.append([idx, sym, z, cov, vdw, color])
    return out

def bond_kinds_for_pdb(mol: Chem.Mol) -> list[list[Any]]:
    """与 bond_orders_for_pdb 同序：返回 [i, j, rdkit_bond_type_name, is_aromatic, bond_type_as_double]。"""
    out: list[list[Any]] = []
    for b in mol.GetBonds():
        i = int(b.GetBeginAtomIdx())
        j = int(b.GetEndAtomIdx())
        if i > j:
            i, j = j, i
        bt = b.GetBondType()
        out.append([i, j, str(bt), bool(b.GetIsAromatic()), float(b.GetBondTypeAsDouble())])
    return out

def _symm_sssr_rings_0based(mol: Chem.Mol) -> list[list[int]]:
    """RDKit 对称 SSSR（与 MolToPDB/键序 同一套 0..N-1 原子下标）。"""
    try:
        rings = rdmolops.GetSymmSSSR(mol)
    except Exception:  # noqa: BLE001
        try:
            ri = mol.GetRingInfo()
            if ri is not None and ri.NumRings():
                return [list(map(int, r)) for r in ri.AtomRings()]
        except Exception:  # noqa: BLE001
            return []
        return []
    return [[int(x) for x in r] for r in rings]


def _normalize_embed_smiles(raw: str) -> str:
    """浏览器/输入法可能带入全角符号或兼容字符；NFKC 后再交给 RDKit。"""
    if not raw:
        return ""
    s = unicodedata.normalize("NFKC", raw).strip()
    for u, asc in (
        ("\ufeff", ""),
        ("\u2010", "-"),
        ("\u2011", "-"),
        ("\u2012", "-"),
        ("\u2013", "-"),
        ("\u2014", "-"),
        ("\u2212", "-"),
    ):
        s = s.replace(u, asc)
    return s.strip()


def mol_from_smiles_embed(s: str) -> Chem.Mol | None:
    """
    先标准解析；失败时再尝试 sanitize=False + SanitizeMol（少数写法在严格模式下会先失败）。
    """
    s = _normalize_embed_smiles(s)
    if not s:
        return None
    mol = Chem.MolFromSmiles(s, sanitize=True)
    if mol is not None:
        return mol
    mol = Chem.MolFromSmiles(s, sanitize=False)
    if mol is None:
        return None
    try:
        Chem.SanitizeMol(mol)
        return mol
    except Exception:  # noqa: BLE001
        return None


def _pick_etkdg() -> Any:
    for name in ("ETKDGv3", "ETKDGv2", "ETKDG"):
        p = getattr(AllChem, name, None)
        if p is not None:
            try:
                return p()
            except TypeError:
                return p
    return None


def embed_and_molblock(
    smiles: str,
) -> tuple[str, str, str, dict[str, Any], list[list[int]], list[list[int]], list[list[Any]], list[list[Any]]]:
    mol = mol_from_smiles_embed(smiles)
    if mol is None:
        raise ValueError("invalid_smiles")
    mol = Chem.AddHs(mol)
    params = _pick_etkdg()
    if params is not None:
        rid = AllChem.EmbedMolecule(mol, params)
    else:
        rid = AllChem.EmbedMolecule(mol)
    meta: dict[str, Any] = {"embedReturn": int(rid)}
    if rid == -1:
        rid2 = AllChem.EmbedMolecule(mol, randomSeed=0xC0FFEE)
        meta["embedRetryReturn"] = int(rid2)
        if rid2 == -1:
            # 大分子 / 约束多构象时 ETKDG 常失败；随机初值坐标仍可生成合法 3D（略损精度优于直接 400）
            rid3 = AllChem.EmbedMolecule(mol, useRandomCoords=True)
            meta["embedRandomCoordsReturn"] = int(rid3)
            if rid3 == -1:
                raise ValueError("embed_failed")
            meta["embedFallback"] = "random_coords"
    ff_ok = 1
    try:
        ff_ok = int(AllChem.MMFFOptimizeMolecule(mol, maxIters=500))
        meta["mmffReturn"] = ff_ok
    except Exception as e:  # noqa: BLE001
        meta["mmffError"] = str(e)
        ff_ok = -1
        meta["mmffReturn"] = -1
    if ff_ok != 0:
        try:
            uff_ok = int(AllChem.UFFOptimizeMolecule(mol, maxIters=400))
            meta["uffReturn"] = uff_ok
        except Exception as e2:  # noqa: BLE001
            meta["uffError"] = str(e2)
    mb = Chem.MolToMolBlock(mol)
    if not mb or len(mb) < 20:
        raise ValueError("empty_molblock")
    pdb = Chem.MolToPDBBlock(mol) or ""
    sdf = ""
    try:
        buf = StringIO()
        w = Chem.SDWriter(buf)
        w.write(mol)
        w.close()
        sdf = buf.getvalue() or ""
    except Exception:  # noqa: BLE001
        sdf = ""
    bo = bond_orders_for_pdb(mol)
    sssr = _symm_sssr_rings_0based(mol)
    kinds = bond_kinds_for_pdb(mol)
    atom_styles = atom_styles_for_pdb(mol)
    return mb, pdb, sdf, meta, bo, sssr, kinds, atom_styles


_EMBED_RESULT_CACHE: OrderedDict[str, tuple] = OrderedDict()
_EMBED_CACHE_MAX = int(os.environ.get("RDKIT_EMBED_CACHE_MAX", "256"))


def _embed_cache_key(raw: str) -> str:
    s = _normalize_embed_smiles(raw)
    if not s:
        return ""
    m = mol_from_smiles_embed(s)
    if m is None:
        return s
    return Chem.MolToSmiles(m)


def embed_and_molblock_cached(
    smiles: str,
) -> tuple[str, str, str, dict[str, Any], list[list[int]], list[list[int]], list[list[Any]], list[list[Any]]]:
    """
    与 embed_and_molblock 结果一致；以规范化 SMILES 为键做进程内 LRU，
    供 /embed 与 /api/mol-3d 复用，减少重复 ETKDG/MMFF 计算（不改变化学结果）。
    """
    key = _embed_cache_key(smiles)
    if not key:
        raise ValueError("empty_smiles")
    if key in _EMBED_RESULT_CACHE:
        _EMBED_RESULT_CACHE.move_to_end(key)
        return _EMBED_RESULT_CACHE[key]
    out = embed_and_molblock(smiles)
    _EMBED_RESULT_CACHE[key] = out
    if len(_EMBED_RESULT_CACHE) > _EMBED_CACHE_MAX:
        _EMBED_RESULT_CACHE.popitem(last=False)
    return out


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/embed")
def embed(req: EmbedRequest) -> dict[str, Any]:
    raw = _normalize_embed_smiles(req.smiles)
    if not raw:
        raise HTTPException(status_code=400, detail="empty_smiles")
    try:
        molblock, pdb, sdf, meta, bond_orders, sssr_rings, bond_kinds, atom_styles = embed_and_molblock_cached(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {
        "ok": True,
        "molblock": molblock,
        "pdb": pdb,
        "sdf": sdf,
        "meta": meta,
        "bondOrders": bond_orders,
        "sssrRings": sssr_rings,
        "bondKinds": bond_kinds,
        "atomStyles": atom_styles,
    }


@app.post("/api/mol-3d")
def api_mol_3d(req: EmbedRequest) -> dict[str, Any]:
    """与 `space/mol-3dmol.js` 约定一致：供银河飞跃页从本服务拉取 molblock（等同 /embed 的分子块）。"""
    raw = _normalize_embed_smiles(req.smiles)
    if not raw:
        raise HTTPException(status_code=400, detail="empty_smiles")
    try:
        molblock, _pdb, _sdf, meta, _bo, _ssr, _bk, _as = embed_and_molblock_cached(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
    mol_blk = Chem.MolFromMolBlock(molblock)
    smiles_canonical = Chem.MolToSmiles(mol_blk) if mol_blk else raw
    er = meta.get("embedReturn")
    mr = meta.get("mmffReturn")
    ur = meta.get("uffReturn")
    rdkit_note = f"embedReturn={er} mmff={mr}" + (f" uff={ur}" if ur is not None else "")
    return {"molblock": molblock, "smiles_canonical": smiles_canonical, "rdkit_note": rdkit_note}


@app.post("/api/similar-drugs")
def api_similar_drugs(req: SimilarDrugsRequest) -> dict[str, Any]:
    """摩根指纹 Tanimoto，对 `data/FDA_Approved_1234.tsv` 检索 Top-K（与探索素材 `_core.query_topk_similar_drugs` 一致）。"""
    raw = _normalize_embed_smiles(req.smiles)
    if not raw:
        raise HTTPException(status_code=400, detail="empty_smiles")
    try:
        return fda_query_topk_similar_drugs(raw, n_jobs=req.n_jobs, top_k=req.top_k)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/fda-random-molecules")
def api_fda_random_molecules(req: RandomMoleculesRequest) -> dict[str, Any]:
    """从 FDA TSV 库随机抽取若干条（飞跃星空分子等）。"""
    try:
        return fda_sample_random_molecules(count=req.count, seed=req.seed)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/display_properties")
def display_properties(req: EmbedRequest) -> dict[str, Any]:
    raw = _normalize_embed_smiles(req.smiles)
    if not raw:
        raise HTTPException(status_code=400, detail="empty_smiles")
    try:
        data = get_molecule_display_properties(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
    if data.get("valid") is False:
        raise HTTPException(status_code=400, detail=str(data.get("error") or "invalid_smiles"))
    return {"ok": True, "data": data}


def main() -> None:
    import uvicorn

    host = "127.0.0.1"
    port = 8767
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])
        if a == "--host" and i + 1 < len(sys.argv):
            host = sys.argv[i + 1]
    uvicorn.run(app, host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
