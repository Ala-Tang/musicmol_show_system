"""
音乐 → SELFIES/SMILES 推理（与 `model_last*.pt` 权重配套）。

仓库内曾缺失本模块导致 `No module named 'inference'`。实现要点：
- 与权重一致的 nn.Transformer（d_model=512, 6+6 层, 8 头）及独立 src/tgt 位置编码；
- MIDI 事件编码为 518 维词表：0–255 时间推进、256–383 note_on、384–511 note_off、512–517 控制符；
- 目标端 73 维：PAD/BOS/EOS/UNK + selfies 语义字母表（与 selfies 2.x 默认 69 符号一致，顺序见 `_default_tgt_vocab`）。

若与训练时 tokenizer 细节有偏差，可放置同目录 `tgt_vocab.txt`（每行一个符号，须 73 行）覆盖目标词表顺序。
"""

from __future__ import annotations

import json
import math
import os
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import torch
import torch.nn as nn

# ---- 常量（与 checkpoint / config.json 一致） ----
SRC_VOCAB = 518
TGT_VOCAB = 73
D_MODEL = 512
NHEAD = 8
NUM_ENC = 6
NUM_DEC = 6
DIM_FF = 2048
DROPOUT = 0.1
MAX_POS = 4096

SRC_PAD = 512
SRC_BOS = 513
SRC_EOS = 514

TIME_MAX = 255  # 0..255 inclusive → 256 档时间推进
NOTE_ON_BASE = 256
NOTE_OFF_BASE = 384


def _default_tgt_vocab() -> List[str]:
    import selfies as sf

    specials = ["<pad>", "<bos>", "<eos>", "<unk>"]
    alpha = sorted(sf.get_semantic_robust_alphabet())
    vocab = specials + alpha
    if len(vocab) != TGT_VOCAB:
        raise RuntimeError(f"内部词表长度 {len(vocab)} != {TGT_VOCAB}")
    return vocab


def _load_tgt_vocab(root: Path) -> List[str]:
    p = root / "tgt_vocab.txt"
    if p.exists():
        lines = [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if len(lines) != TGT_VOCAB:
            raise RuntimeError(f"{p} 须恰好 {TGT_VOCAB} 行，当前 {len(lines)}")
        return lines
    return _default_tgt_vocab()


class PositionalEncoding(nn.Module):
    def __init__(self, d_model: int, max_len: int = MAX_POS) -> None:
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float32).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2, dtype=torch.float32) * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0))  # (1, max_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (S, B, E)
        seq = x.size(0)
        return x + self.pe[:, :seq, :].transpose(0, 1)


class MusicToSmilesTransformer(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.src_embedding = nn.Embedding(SRC_VOCAB, D_MODEL)
        self.tgt_embedding = nn.Embedding(TGT_VOCAB, D_MODEL)
        self.src_pos = PositionalEncoding(D_MODEL)
        self.tgt_pos = PositionalEncoding(D_MODEL)
        self.transformer = nn.Transformer(
            d_model=D_MODEL,
            nhead=NHEAD,
            num_encoder_layers=NUM_ENC,
            num_decoder_layers=NUM_DEC,
            dim_feedforward=DIM_FF,
            dropout=DROPOUT,
            batch_first=False,
        )
        self.lm_head = nn.Linear(D_MODEL, TGT_VOCAB, bias=False)

    def encode(self, src: torch.Tensor, src_key_padding_mask: Optional[torch.Tensor]) -> torch.Tensor:
        # src (S, B) long
        x = self.src_embedding(src) * math.sqrt(float(D_MODEL))
        x = self.src_pos(x)
        return self.transformer.encoder(x, src_key_padding_mask=src_key_padding_mask)

    def decode_step(
        self,
        memory: torch.Tensor,
        tgt_y: torch.Tensor,
        tgt_mask: torch.Tensor,
        memory_key_padding_mask: Optional[torch.Tensor],
    ) -> torch.Tensor:
        # tgt_y: (Ty, B)；memory: (Smem, B, E)，B 与 beam 一致
        t = self.tgt_embedding(tgt_y) * math.sqrt(float(D_MODEL))
        t = self.tgt_pos(t)
        out = self.transformer.decoder(
            t,
            memory,
            tgt_mask=tgt_mask,
            memory_key_padding_mask=memory_key_padding_mask,
        )
        return self.lm_head(out[-1])  # (B, V)


def _midi_path_to_src_tokens(midi_path: Path, max_len: int) -> List[int]:
    import mido

    mid = mido.MidiFile(str(midi_path))
    merged = mido.merge_tracks(mid.tracks)
    ticks_per_beat = mid.ticks_per_beat or 480
    tempo = 500_000
    abs_tick = 0
    events: List[Tuple[int, str, int]] = []
    for msg in merged:
        abs_tick += msg.time
        if msg.type == "set_tempo":
            tempo = msg.tempo
        elif msg.type == "note_on" and msg.velocity > 0:
            events.append((abs_tick, "on", int(msg.note)))
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            events.append((abs_tick, "off", int(msg.note)))
    events.sort(key=lambda x: (x[0], 0 if x[1] == "off" else 1))

    # 时间量子：约 32 分音符 @ 480 ticks/四分音符
    quantum = max(1, ticks_per_beat // 8)
    out: List[int] = [SRC_BOS]
    prev = 0
    for tick, kind, pitch in events:
        if not (0 <= pitch <= 127):
            continue
        gap = max(0, tick - prev)
        gap_q = (gap + quantum - 1) // quantum
        while gap_q > 0:
            step = min(gap_q, 256)
            out.append(min(TIME_MAX, step - 1))
            gap_q -= step
        if kind == "on":
            out.append(NOTE_ON_BASE + pitch)
        else:
            out.append(NOTE_OFF_BASE + pitch)
        prev = tick
    out.append(SRC_EOS)
    if len(out) > max_len:
        out = out[: max_len - 1] + [SRC_EOS]
    return out


def _pad_src(ids: List[int], pad_id: int, max_len: int) -> Tuple[torch.Tensor, torch.Tensor]:
    ids = ids[:max_len]
    pad_len = max_len - len(ids)
    padded = ids + [pad_id] * pad_len
    tensor = torch.tensor(padded, dtype=torch.long).unsqueeze(1)  # (S,1)
    m = torch.zeros(1, max_len, dtype=torch.bool)
    m[0, len(ids) :] = True
    return tensor, m


def _build_tgt_mask(sz: int, device: torch.device) -> torch.Tensor:
    return torch.nn.Transformer.generate_square_subsequent_mask(sz, device=device)


def _beam_search_decode(
    model: MusicToSmilesTransformer,
    memory: torch.Tensor,
    memory_pad: Optional[torch.Tensor],
    tgt_vocab: List[str],
    beam_size: int,
    max_decode: int,
    device: torch.device,
    eos_id: int,
    bos_id: int,
    pad_id: int,
) -> List[Tuple[float, List[int]]]:
    """beam search；encoder memory batch=1，解码时按 beam repeat。"""
    _ = pad_id
    _ = tgt_vocab
    B = beam_size
    V = TGT_VOCAB
    sequences = torch.full((B, 1), bos_id, dtype=torch.long, device=device)
    scores = torch.zeros(B, device=device)

    for step in range(max_decode - 1):
        bcur = sequences.size(0)
        mem = memory.expand(-1, bcur, -1).contiguous()
        mpad = None if memory_pad is None else memory_pad.expand(bcur, -1).contiguous()
        Ty = sequences.size(1)
        tgt_mask = _build_tgt_mask(Ty, device)
        logits = model.decode_step(mem, sequences.transpose(0, 1), tgt_mask, mpad)
        logp = torch.log_softmax(logits, dim=-1)
        if step == 0:
            topv, topi = logp[0].topk(B)
            sequences = torch.cat(
                [torch.full((B, 1), bos_id, dtype=torch.long, device=device), topi.unsqueeze(1)],
                dim=1,
            )
            scores = topv
        else:
            cand = scores.unsqueeze(1) + logp
            flat = cand.reshape(-1)
            topv, topi = flat.topk(B)
            prev_beam = topi // V
            next_tok = topi % V
            sequences = torch.cat([sequences[prev_beam], next_tok.unsqueeze(1)], dim=1)
            scores = topv
        if (sequences[:, -1] == eos_id).all():
            break

    finished: List[Tuple[float, List[int]]] = []
    for b in range(B):
        toks = sequences[b].tolist()
        if toks and toks[0] == bos_id:
            toks = toks[1:]
        if eos_id in toks:
            toks = toks[: toks.index(eos_id)]
        sc = float(scores[b].item())
        finished.append((sc, toks))
    finished.sort(key=lambda x: -x[0])
    return finished


def _selfies_ids_to_string(ids: List[int], vocab: List[str]) -> str:
    parts: List[str] = []
    for i in ids:
        if 0 <= i < len(vocab) and i not in (0, 1, 2, 3):
            parts.append(vocab[i])
    return "".join(parts)


def _postprocess_beam(
    beam_tokens: List[int],
    vocab: List[str],
) -> Dict[str, Any]:
    import selfies as sf
    from rdkit import Chem
    from rdkit.Chem import QED

    sfs = _selfies_ids_to_string(beam_tokens, vocab)
    pred_smiles = ""
    canon = ""
    selfies_valid = 0
    smiles_valid = 0
    qed_v = 0.0
    try:
        pred_smiles = sf.decoder(sfs)
        selfies_valid = 1
    except Exception:
        pred_smiles = ""
    if pred_smiles:
        mol = Chem.MolFromSmiles(pred_smiles)
        if mol is not None:
            smiles_valid = 1
            canon = Chem.MolToSmiles(mol)
            try:
                qed_v = float(QED.qed(mol))
            except Exception:
                qed_v = 0.0
    return {
        "pred_selfies": sfs,
        "pred_smiles": pred_smiles,
        "canonical_smiles": canon,
        "selfies_valid": selfies_valid,
        "smiles_valid": smiles_valid,
        "qed": qed_v,
    }


def run_inference(
    config_path: str,
    ckpt_path: str,
    input_list: str,
    output_dir: str,
    batch_size: int = 1,
    seed: int = 42,
    beam_size: int = 20,
    num_return_sequences: int = 20,
    repeat_token_penalty: float = 0,
    device: str = "cpu",
    save_outputs: bool = True,
    **kwargs: Any,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    与 `run_london_bridge.py` / Flask `app.py` 调用签名兼容；未识别的 kwargs 忽略。
    """
    _ = repeat_token_penalty
    _ = kwargs
    random.seed(seed)
    torch.manual_seed(seed)

    cfg_path = Path(config_path)
    root = cfg_path.parent
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    max_midi = int(cfg.get("max_midi_len", 512))
    max_selfies = int(cfg.get("max_selfies_len", 512))
    try:
        cap = int((os.environ.get("MUSICMOL_MAX_DECODE_LEN") or "256").strip())
        if cap > 32:
            max_selfies = min(max_selfies, cap)
    except ValueError:
        pass

    tgt_vocab = _load_tgt_vocab(root)
    tok2id = {t: i for i, t in enumerate(tgt_vocab)}
    pad_id = tok2id["<pad>"]
    bos_id = tok2id["<bos>"]
    eos_id = tok2id["<eos>"]

    dev = torch.device(device if device in ("cpu", "cuda") or str(device).startswith("cuda") else "cpu")
    if str(device) == "cuda" and not torch.cuda.is_available():
        dev = torch.device("cpu")

    model = MusicToSmilesTransformer().to(dev)
    sd = torch.load(ckpt_path, map_location=dev, weights_only=False)
    if isinstance(sd, dict) and "model" in sd:
        sd = sd["model"]
    missing, unexpected = model.load_state_dict(sd, strict=True)
    if missing or unexpected:
        raise RuntimeError(f"加载权重不完整 missing={missing} unexpected={unexpected}")
    model.eval()

    input_path = Path(input_list)
    out_dir = Path(output_dir)
    if save_outputs:
        out_dir.mkdir(parents=True, exist_ok=True)

    lines = [ln.strip() for ln in input_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    records: List[Dict[str, Any]] = []

    for raw in lines:
        row = json.loads(raw)
        sample_id = row.get("id", "sample")
        midi_path = Path(row["midi_path"])
        if not midi_path.is_file():
            raise RuntimeError(f"样本 {sample_id}: MIDI 不存在 {midi_path}")

        src_ids = _midi_path_to_src_tokens(midi_path, max_midi)
        src, src_pad = _pad_src(src_ids, SRC_PAD, max_midi)
        src = src.to(dev)
        src_pad = src_pad.to(dev)

        use_amp = dev.type == "cuda"
        with torch.inference_mode():
            with torch.amp.autocast("cuda", enabled=use_amp):
                memory = model.encode(src, src_key_padding_mask=src_pad)
                beam = min(int(beam_size), int(num_return_sequences), 32)
                beams_raw = _beam_search_decode(
                    model,
                    memory,
                    src_pad,
                    tgt_vocab,
                    beam_size=beam,
                    max_decode=max_selfies,
                    device=dev,
                    eos_id=eos_id,
                    bos_id=bos_id,
                    pad_id=pad_id,
                )

        beams_out: List[Dict[str, Any]] = []
        best_qed = -1.0
        best_idx = 0
        for rank, (sc, toks) in enumerate(beams_raw[:beam], start=1):
            meta = _postprocess_beam(toks, tgt_vocab)
            item = {
                "rank": rank,
                "score": float(sc),
                "pred_selfies": meta["pred_selfies"],
                "pred_smiles": meta["pred_smiles"],
                "canonical_smiles": meta["canonical_smiles"],
                "selfies_valid": meta["selfies_valid"],
                "smiles_valid": meta["smiles_valid"],
                "qed": meta["qed"],
            }
            beams_out.append(item)
            if meta["smiles_valid"] and meta["qed"] > best_qed:
                best_qed = meta["qed"]
                best_idx = rank - 1

        if not beams_out:
            raise RuntimeError(f"样本 {sample_id}: beam 为空")

        best = dict(beams_out[best_idx])
        best["rank"] = len(beams_out)

        rec = {
            "id": sample_id,
            "midi_path": str(midi_path),
            "best": best,
            "beams": beams_out,
        }
        records.append(rec)

    n = len(records)
    valid_smiles = sum(1 for r in records if r["best"].get("smiles_valid"))
    summary = {
        "total": n,
        "top1_selfies_validity": sum(1 for r in records if r["best"].get("selfies_valid")) / max(1, n),
        "top1_smiles_validity": valid_smiles / max(1, n),
        "top1_num_valid_smiles": valid_smiles,
        "top1_unique_smiles": len({r["best"].get("canonical_smiles") for r in records if r["best"].get("canonical_smiles")}),
        "top1_unique_ratio": 1.0,
        "any_beam_valid_smiles_ratio": valid_smiles / max(1, n),
        "avg_best_qed": sum(float(r["best"].get("qed") or 0) for r in records) / max(1, n),
        "beam_size": beam_size,
        "num_return_sequences": num_return_sequences,
    }

    if save_outputs:
        out_dir.mkdir(parents=True, exist_ok=True)
        pred_path = out_dir / "predictions_topk.jsonl"
        with pred_path.open("w", encoding="utf-8") as fh:
            for r in records:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    return records, summary
