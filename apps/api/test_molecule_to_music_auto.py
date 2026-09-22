#!/usr/bin/env python3
"""
分子到音乐 自动化自检（不依赖 Flask 进程）。
用法（推荐）:
  conda activate musicmol
  cd MusicMol_0322 && python test_molecule_to_music_auto.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MOL_MUSIC_DIR = _REPO_ROOT.parent / "packages" / "molecule-to-music"
_MUSICMOL_DIR = Path(__file__).resolve().parent


class TestMoleculeToMusic(unittest.TestCase):
    """验证 Cython 扩展与 app._generate_midi_events_from_smiles 端到端可用。"""

    @classmethod
    def setUpClass(cls):
        if not _MOL_MUSIC_DIR.is_dir():
            raise unittest.SkipTest(f"缺少目录: {_MOL_MUSIC_DIR}")
        so = list((_MOL_MUSIC_DIR / "smile_to_midi_v10").glob("_core.cpython-*-linux-gnu.so"))
        if not so:
            raise unittest.SkipTest("未找到 smile_to_midi_v10 编译扩展 (.so)")

    def test_01_smile_to_midi_v10_writes_midi(self):
        sys.path.insert(0, str(_MOL_MUSIC_DIR))
        import mido
        import smile_to_midi_v10

        tmp = tempfile.NamedTemporaryFile(suffix=".mid", delete=False)
        tmp.close()
        try:
            smile_to_midi_v10.smiles_to_midi("CCO", tmp.name, tempo_bpm=100)
            self.assertTrue(os.path.getsize(tmp.name) > 0)
            mid = mido.MidiFile(tmp.name)
            merged = list(mido.merge_tracks(mid.tracks))
            note_ons = [m for m in merged if m.type == "note_on" and getattr(m, "velocity", 0) > 0]
            self.assertGreater(len(note_ons), 0, "MIDI 中应有至少一个 note_on")
        finally:
            os.unlink(tmp.name)

    def test_02_generate_midi_events_from_smiles(self):
        sys.path.insert(0, str(_MUSICMOL_DIR))
        import app as app_mod

        ev = app_mod._generate_midi_events_from_smiles("c1ccccc1", 96)
        self.assertIsInstance(ev, list)
        self.assertGreater(len(ev), 0, "应对苯生成至少一条音符事件")
        first = ev[0]
        self.assertIn("note", first)
        self.assertIn("time", first)
        self.assertIn("duration", first)
        self.assertGreaterEqual(first["note"], 0)
        self.assertLessEqual(first["note"], 127)

    def test_03_unparsable_smiles_yields_no_events(self):
        """Cython 对某些字符串仍会产出 MIDI；此处选用当前实现对 RDKit 不可解析且产出为空的用例。"""
        sys.path.insert(0, str(_MUSICMOL_DIR))
        import app as app_mod

        ev = app_mod._generate_midi_events_from_smiles("QQ", 100)
        self.assertFalse(ev, "QQ 应对当前管线不产生可演奏事件")


if __name__ == "__main__":
    unittest.main(verbosity=2)
