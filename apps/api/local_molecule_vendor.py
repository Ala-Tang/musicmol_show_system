"""
解析 musicmol_vs 仓库中「分子到音乐」本地目录，供 API 与前端展示（离线说明 / 路径探测）。
"""
import sys
from pathlib import Path
from typing import List, Optional, Tuple

_APP_DIR = Path(__file__).resolve().parent


def _candidate_molecule_music_dirs() -> List[Path]:
    """与 MusicMol_0322 的常见放置方式：vendor 下或与仓库同级 pinao8。"""
    yield _APP_DIR / "vendor" / "musicmol_vs-master" / "model" / "分子到音乐"
    yield _APP_DIR.parent / "musicmol_vs-master" / "model" / "分子到音乐"


def resolve_molecule_music_dir() -> Optional[Path]:
    for p in _candidate_molecule_music_dirs():
        if p.is_dir():
            return p
    return None


def _read_readme_excerpt(mol_dir: Path, max_chars: int = 900) -> str:
    readme = mol_dir / "README.md"
    if not readme.is_file():
        return "(未找到 README.md)"
    try:
        text = readme.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "(README.md 无法读取)"
    text = text.strip()
    if len(text) > max_chars:
        return text[:max_chars] + "\n…"
    return text


def try_smile_to_midi_import(mol_dir: Path) -> Tuple[bool, Optional[str]]:
    """smile_to_midi_v10 依赖编译后的 _core；多数下载包不含二进制。"""
    parent = str(mol_dir)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    try:
        import smile_to_midi_v10  # noqa: F401

        return True, None
    except Exception as e:
        return False, str(e)


def vendor_info_dict() -> dict:
    mol_dir = resolve_molecule_music_dir()
    if mol_dir is None:
        return {
            "resolved": False,
            "molecule_music_dir": None,
            "candidates": [str(p) for p in _candidate_molecule_music_dirs()],
            "readme_excerpt": None,
            "smile_to_midi_import_ok": False,
            "smile_to_midi_import_error": "目录未找到",
            "note": "请将 musicmol_vs-master 置于 MusicMol_0322/vendor/ 或与 MusicMol_0322 同级的 pinao8/ 下。",
        }
    ok, err = try_smile_to_midi_import(mol_dir)
    return {
        "resolved": True,
        "molecule_music_dir": str(mol_dir),
        "candidates": [str(p) for p in _candidate_molecule_music_dirs()],
        "readme_excerpt": _read_readme_excerpt(mol_dir),
        "smile_to_midi_import_ok": ok,
        "smile_to_midi_import_error": err,
        "note": "网页演奏仍使用 smile_to_score_v4.js；若 smile_to_midi_v10 可导入，可在服务端后续扩展为 music21 管线。",
    }


def enrich_parse(parse: dict) -> dict:
    """在 parse 中附加 local_vendor_musicmol（musicmol_vs 本地目录探测结果）。"""
    if not isinstance(parse, dict):
        parse = {}
    p = dict(parse)
    p["local_vendor_musicmol"] = vendor_info_dict()
    return p
