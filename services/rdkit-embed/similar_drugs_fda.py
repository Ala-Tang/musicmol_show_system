"""
FDA TSV 摩根指纹 Tanimoto Top-K，与 space/musicmol_vs-master/开发素材/钢琴演奏结束生成分子后探索/qurey/_core.py 对齐。
"""

from __future__ import annotations

import hashlib
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from rdkit import Chem, DataStructs
from rdkit.Chem import AllChem

_DATA_DIR = Path(__file__).resolve().parent / "data"
_REPO_ROOT = Path(__file__).resolve().parents[2]
# 优先使用探索目录 TSV（与需求「钢琴演奏结束生成分子后探索」一致）；否则回退到嵌入服务自带 data 副本
_EXPLORER_TSV = _REPO_ROOT / "钢琴演奏结束生成分子后探索" / "FDA_Approved_1234.tsv"
_DATA_TSV = _DATA_DIR / "FDA_Approved_1234.tsv"
_TSV_PATH = _EXPLORER_TSV if _EXPLORER_TSV.is_file() else _DATA_TSV

_LIB_CACHE: Optional[List[Tuple[str, str]]] = None


def _load_library() -> List[Tuple[str, str]]:
    rows: List[Tuple[str, str]] = []
    with open(_TSV_PATH, encoding="utf-8") as f:
        _header = f.readline()
        for line in f:
            line = line.rstrip("\n\r")
            if not line.strip():
                continue
            parts = line.split("\t", 1)
            if len(parts) < 2:
                continue
            smi, name = parts[0].strip(), parts[1].strip()
            if smi:
                rows.append((smi, name))
    return rows


def _get_library() -> List[Tuple[str, str]]:
    global _LIB_CACHE
    if _LIB_CACHE is None:
        _LIB_CACHE = _load_library()
    return _LIB_CACHE


def _morgan_fp(mol: Chem.Mol):
    return AllChem.GetMorganFingerprintAsBitVect(mol, 2, nBits=2048)


def _synthetic_ttd_id(smiles: str) -> str:
    h = hashlib.md5(smiles.encode("utf-8")).hexdigest()[:5].upper()
    return f"D0{h}"


def _tanimoto_pair(args):
    ref_fp, idx, smi, name = args
    m = Chem.MolFromSmiles(smi)
    if m is None:
        return None
    fp = _morgan_fp(m)
    return (DataStructs.TanimotoSimilarity(ref_fp, fp), idx, smi, name)


def query_topk_similar_drugs(
    input_smi: str,
    n_jobs: int = 12,
    top_k: int = 5,
) -> Dict[str, Any]:
    _ = n_jobs
    q = Chem.MolFromSmiles(input_smi)
    if q is None:
        raise ValueError(f"无法解析查询 SMILES: {input_smi!r}")
    ref_fp = _morgan_fp(q)
    lib = _get_library()
    tasks = [(ref_fp, i, smi, name) for i, (smi, name) in enumerate(lib)]

    scored = [_tanimoto_pair(t) for t in tasks]
    scored = [x for x in scored if x is not None]
    scored.sort(key=lambda x: -x[0])
    top = scored[: int(top_k)]

    results: List[Dict[str, Any]] = []
    for rank, (sim, _idx, smi, drug_name) in enumerate(top, start=1):
        pct = round(sim * 100, 2)
        results.append(
            {
                "排名": rank,
                "相似度": f"{pct:.2f}%",
                "药物ID（TTD）": _synthetic_ttd_id(smi),
                "通用名": drug_name,
                "商品名": None,
                "SMILES": smi,
                "开发公司": None,
                "研发阶段": "FDA Approved (TSV)",
                "治疗类别": None,
                "作用靶标": None,
                "作用机制（MOA）": None,
                "适应症": None,
            }
        )

    return {
        "query_smiles": input_smi,
        "top_k": int(top_k),
        "results": results,
    }


def sample_random_molecules(count: int = 16, seed: int | None = None) -> Dict[str, Any]:
    """
    从 FDA TSV 库中无放回随机抽取若干条（供飞跃「星空分子」等展示，与相似度检索独立）。
    """
    lib = _get_library()
    if not lib:
        return {"results": [], "count": 0}
    n = max(1, min(int(count), 40, len(lib)))
    rng = random.Random(seed)
    idxs = rng.sample(range(len(lib)), k=min(n, len(lib)))
    results: List[Dict[str, Any]] = []
    for rank, idx in enumerate(idxs, start=1):
        smi, drug_name = lib[idx]
        results.append(
            {
                "排名": rank,
                "相似度": "—",
                "药物ID（TTD）": _synthetic_ttd_id(smi),
                "通用名": drug_name,
                "商品名": None,
                "SMILES": smi,
                "开发公司": None,
                "研发阶段": "FDA Approved (TSV)",
                "治疗类别": None,
                "作用靶标": None,
                "作用机制（MOA）": None,
                "适应症": None,
            }
        )
    return {"results": results, "count": len(results)}
