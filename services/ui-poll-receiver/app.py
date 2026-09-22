#!/usr/bin/env python3
"""
PainoJS 玻璃盒嵌入层用的「接收端」：在 8082 提供 GET，与前端 MUSICMOL_UI_POLL_BASE 一致。

- GET /api/molecule_music_ui_pending  （默认不消费；`?consume=1` 才清空）
- GET /api/midi_exchange/ui_pending  （默认不消费；`?consume=1` 才清空）
- GET /api/glass_session_ui_pending  （FIFO：整包 / 仅 MIDI / 仅 SMILES，每次读取弹出队首一条）
- GET /__peek/pending  （仅探测是否有排队数据，**不消费**，供监控脚本使用）
- GET /api/manual_molecule_music_ui_status?session_id=…  （手动「生成分子音乐」进度轮询）
- POST /__push/manual_molecule_music_session  （浏览器注册 generating）
- POST /__push/manual_molecule_music_phase  （外设推送 playing / finished）

数据为内存队列；SMILES 与 MIDI 默认「只读不清空」（显式 `?consume=1` 才清空），
glass_session 队列为 FIFO；`POST /__push/glass_session` 可推送整包或仅 MIDI、仅 SMILES（详见 DOC/GLASS_SESSION_PUSH_API.md）。

环境变量：
  UI_POLL_HOST  默认 0.0.0.0
  UI_POLL_PORT  默认 8082
  PAINOJS_5020_API_LOG_PATH  映射端上报的「→5020 API」NDJSON 日志文件（默认 <项目根>/logs/painojs-5020-api.log）

浏览器在开启 api5020Log 时向 POST /__paino/log_5020_api 批量上报（见 js/paino/logging/musicMol5020ApiLogger.global.js）。
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("UI_POLL_HOST", "0.0.0.0")
PORT = int(os.environ.get("UI_POLL_PORT", "8082"))

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_DEFAULT_5020_API_LOG_PATH = os.path.join(_PROJECT_ROOT, "logs", "painojs-5020-api.log")
_log_5020_api_lock = threading.Lock()

_lock = threading.Lock()
_pending_smiles: dict | None = None
_pending_midi: dict | None = None
_glass_session_queue: list[dict] = []
MAX_GLASS_SESSION_QUEUE = 64
_seq_smiles = 0
_seq_midi = 0
_seq_session = 0

# 手动「生成分子音乐」三阶段 UI：session_id -> { phase, ts_ms, smiles? }
_manual_molecule_music: dict[str, dict] = {}
_MANUAL_MUSIC_TTL_MS = 60 * 60 * 1000


def _manual_music_prune() -> None:
    now = int(time.time() * 1000)
    stale = [
        sid
        for sid, row in _manual_molecule_music.items()
        if now - int(row.get("ts_ms") or 0) > _MANUAL_MUSIC_TTL_MS
    ]
    for sid in stale:
        _manual_molecule_music.pop(sid, None)


_PHASE_ORDER = {"none": 0, "generating": 1, "playing": 2, "finished": 3}

def _manual_music_set(session_id: str, phase: str, smiles: str | None = None) -> None:
    sid = (session_id or "").strip()
    if not sid:
        return
    new_phase = str(phase or "").strip().lower() or "none"
    new_rank = _PHASE_ORDER.get(new_phase, 0)
    with _lock:
        prev = _manual_molecule_music.get(sid) or {}
        prev_phase = str(prev.get("phase") or "").strip().lower() or "none"
        prev_rank = _PHASE_ORDER.get(prev_phase, 0)
        if new_rank < prev_rank:
            return
        row = {
            "phase": new_phase,
            "ts_ms": int(time.time() * 1000),
        }
        if smiles is not None:
            row["smiles"] = smiles
        elif prev.get("smiles"):
            row["smiles"] = prev["smiles"]
        _manual_molecule_music[sid] = row


def _next_record_id(kind: str) -> str:
    """与前端 `UI_POLL_RECORD_ID_RE` 一致：UIP-{port}-{seq}-{hex8}。"""
    global _seq_smiles, _seq_midi, _seq_session
    with _lock:
        if kind == "smiles":
            _seq_smiles += 1
            n = _seq_smiles
        elif kind == "midi":
            _seq_midi += 1
            n = _seq_midi
        elif kind == "session":
            _seq_session += 1
            n = _seq_session
        else:
            raise ValueError(f"unknown record kind: {kind!r}")
    suf = secrets.token_hex(4)
    return f"UIP-{PORT}-{n}-{suf}"


def _glass_session_core_from_body(body: dict) -> dict:
    """与前端 `glassSessionCoreFromEnvelope` 一致，用于 receipt_digest。"""
    smiles = (body.get("smiles") or body.get("SMILES") or "").strip()
    events = body.get("events") or body.get("midi_events")
    bpm = int(body.get("bpm") or 100)
    rls = body.get("reveal_last_sec")
    if rls is None or rls == "":
        rls = 5
    else:
        rls = int(rls)
    rls = max(1, min(60, rls))
    events_norm = json.loads(json.dumps(events, ensure_ascii=False))
    session_core: dict = {
        "smiles": smiles,
        "bpm": bpm,
        "events": events_norm,
        "reveal_last_sec": rls,
    }
    if body.get("编号") is not None:
        session_core["编号"] = body["编号"]
    # 须与 `js/paino/api/uiPollReceipt.js` 的 `glassSessionCoreFromEnvelope` 一致：
    # molecule_id → moleculeId → 药物编号 → 编号（勿把「编号」排在「药物编号」前，否则 receipt_digest 与前端不一致）
    mid = None
    for k in ("molecule_id", "moleculeId", "药物编号", "编号"):
        v = body.get(k)
        if v is not None and v != "":
            mid = v
            break
    if mid is not None:
        session_core["molecule_id"] = mid
    return session_core


def _digest_obj(obj: dict) -> str:
    """与前端 `pythonSortKeysJsonStringify` + SHA-256(UTF-8) 一致。"""
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _enqueue_glass_session(row: dict) -> None:
    """FIFO；超长丢队首，避免外设狂刷占满内存。"""
    global _glass_session_queue
    with _lock:
        while len(_glass_session_queue) >= MAX_GLASS_SESSION_QUEUE:
            dropped = _glass_session_queue.pop(0)
            rid = dropped.get("record_id")
            print(f"[ui_poll_receiver] glass_session queue overflow, dropped oldest record_id={rid!r}")
        _glass_session_queue.append(row)


def _parse_reveal_last_sec(body: dict) -> int:
    rls = body.get("reveal_last_sec")
    if rls is None or rls == "":
        return 5
    try:
        rls = int(rls)
    except (TypeError, ValueError):
        return 5
    return max(1, min(60, rls))


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    n = int(handler.headers.get("Content-Length") or 0)
    if n <= 0:
        return {}
    raw = handler.rfile.read(n)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def _append_5020_api_log_entries(entries: list[dict], remote: str) -> int:
    """映射端 →5020 API 上报：NDJSON 一行一条。"""
    path = os.environ.get("PAINOJS_5020_API_LOG_PATH", "").strip() or _DEFAULT_5020_API_LOG_PATH
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    now_ms = int(time.time() * 1000)
    n = 0
    with _log_5020_api_lock:
        with open(path, "a", encoding="utf-8") as fp:
            for row in entries:
                if not isinstance(row, dict):
                    continue
                out = {**row, "server_ingest_ms": now_ms, "remote": remote}
                fp.write(json.dumps(out, ensure_ascii=False) + "\n")
                n += 1
    return n


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[ui_poll_receiver] {self.address_string()} - {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _send_json(self, obj, status=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _send_json_ui_pending(self, obj):
        """轮询体附带 `server_emit_ms`，供前端与 `ts_ingested_ms` 同源比对，避免浏览器与 8082 时钟不一致误拒收。"""
        if isinstance(obj, dict) and obj:
            self._send_json({**obj, "server_emit_ms": int(time.time() * 1000)})
        else:
            self._send_json(obj if obj is not None else {})

    def do_GET(self):
        global _pending_smiles, _pending_midi, _glass_session_queue
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/health":
            self._send_json(
                {
                    "ok": True,
                    "service": "painojs_ui_poll_receiver",
                    "port": PORT,
                    "ui_poll_receipt_version": 1,
                    "endpoints": [
                        "/api/molecule_music_ui_pending",
                        "/api/midi_exchange/ui_pending",
                    "/api/glass_session_ui_pending",
                    "/api/manual_molecule_music_ui_status",
                    "/__peek/pending",
                    "/__paino/log_5020_api",
                ],
            }
            )
            return

        if path == "/api/manual_molecule_music_ui_status":
            _manual_music_prune()
            sid = str((query.get("session_id") or [""])[0]).strip()
            if not sid:
                self._send_json({"error": "missing_session_id", "phase": "none"}, 400)
                return
            with _lock:
                row = _manual_molecule_music.get(sid)
            if not row:
                self._send_json(
                    {
                        "phase": "none",
                        "session_id": sid,
                        "ts_ms": int(time.time() * 1000),
                    }
                )
                return
            self._send_json(
                {
                    "phase": str(row.get("phase") or "none"),
                    "session_id": sid,
                    "ts_ms": int(row.get("ts_ms") or 0),
                }
            )
            return

        if path == "/__peek/pending":
            with _lock:
                hs = _pending_smiles is not None
                hm = _pending_midi is not None
                q = _glass_session_queue
                hg = len(q) > 0
                smiles_preview = None
                midi_count = 0
                rid_s = rid_m = rid_g = None
                glass_head_kind = None
                if _pending_smiles and isinstance(_pending_smiles.get("smiles"), str):
                    s = _pending_smiles["smiles"]
                    smiles_preview = s if len(s) <= 64 else s[:61] + "..."
                    rid_s = _pending_smiles.get("record_id")
                if _pending_midi and isinstance(_pending_midi.get("events"), list):
                    midi_count = len(_pending_midi["events"])
                    rid_m = _pending_midi.get("record_id")
                if q:
                    head = q[0]
                    rid_g = head.get("record_id")
                    glass_head_kind = head.get("glass_delivery_kind")
            self._send_json(
                {
                    "has_smiles": hs,
                    "has_midi": hm,
                    "has_glass_session": hg,
                    "glass_session_queue_depth": len(q),
                    "glass_session_head_kind": glass_head_kind,
                    "smiles_preview": smiles_preview,
                    "midi_event_count": midi_count,
                    "record_id_smiles": rid_s,
                    "record_id_midi": rid_m,
                    "record_id_glass_session": rid_g,
                }
            )
            return

        if path == "/api/glass_session_ui_pending":
            with _lock:
                data = _glass_session_queue.pop(0) if _glass_session_queue else None
            self._send_json_ui_pending(data if data is not None else {})
            return

        if path == "/api/molecule_music_ui_pending":
            with _lock:
                data = _pending_smiles
                consume = str((query.get("consume") or ["0"])[0]).strip().lower() in (
                    "1",
                    "true",
                    "yes",
                    "y",
                    "on",
                )
                if consume:
                    _pending_smiles = None
            self._send_json_ui_pending(data if data is not None else {})
            return

        if path == "/api/midi_exchange/ui_pending":
            with _lock:
                data = _pending_midi
                consume = str((query.get("consume") or ["0"])[0]).strip().lower() in (
                    "1",
                    "true",
                    "yes",
                    "y",
                    "on",
                )
                if consume:
                    _pending_midi = None
            self._send_json_ui_pending(data if data is not None else {})
            return

        self._send_json({"error": "not_found", "path": path}, 404)

    def do_POST(self):
        global _pending_smiles, _pending_midi, _glass_session_queue
        path = urlparse(self.path).path
        body = _read_json_body(self)

        if path == "/__paino/log_5020_api":
            raw_entries = body.get("entries")
            to_write: list[dict] = []
            if isinstance(raw_entries, list):
                to_write = [x for x in raw_entries if isinstance(x, dict)]
            elif isinstance(body, dict) and body.get("kind"):
                to_write = [body]
            if not to_write:
                self._send_json({"ok": False, "error": "no_entries"}, 400)
                return
            n = _append_5020_api_log_entries(to_write, self.address_string())
            self._send_json({"ok": True, "written": n})
            return

        if path == "/__push/glass_session":
            smiles = (body.get("smiles") or body.get("SMILES") or "").strip()
            events = body.get("events") or body.get("midi_events")
            has_smiles = bool(smiles)
            has_events = isinstance(events, list) and len(events) > 0
            if not has_smiles and not has_events:
                self._send_json({"ok": False, "error": "missing_smiles_and_events"}, 400)
                return

            ts_ms = int(time.time() * 1000)

            if has_smiles and has_events:
                try:
                    session_core = _glass_session_core_from_body(body)
                except Exception as ex:
                    self._send_json({"ok": False, "error": "invalid_body", "detail": str(ex)}, 400)
                    return
                rid = _next_record_id("session")
                digest = _digest_obj(session_core)
                out: dict = {
                    "glass_delivery_kind": "full",
                    "smiles": session_core["smiles"],
                    "events": session_core["events"],
                    "bpm": int(session_core["bpm"]),
                    "reveal_last_sec": int(session_core["reveal_last_sec"]),
                    "pending": True,
                    "record_id": rid,
                    "ts_ingested_ms": ts_ms,
                    "receipt_digest": digest,
                }
                if "编号" in session_core:
                    out["编号"] = session_core["编号"]
                if "molecule_id" in session_core:
                    out["molecule_id"] = session_core["molecule_id"]
                if "编号" not in out and "molecule_id" in session_core:
                    out["编号"] = session_core["molecule_id"]
                _enqueue_glass_session(out)
                self._send_json(
                    {
                        "ok": True,
                        "queued": True,
                        "glass_delivery_kind": "full",
                        "record_id": rid,
                        "ts_ingested_ms": ts_ms,
                        "receipt_digest": digest,
                        "event_count": len(session_core["events"]),
                    }
                )
                return

            if has_events:
                bpm = int(body.get("bpm") or 100)
                events_norm = json.loads(json.dumps(events, ensure_ascii=False))
                midi_core: dict = {"bpm": bpm, "events": events_norm}
                if body.get("molecule_id") is not None:
                    midi_core["molecule_id"] = body["molecule_id"]
                elif body.get("moleculeId") is not None:
                    midi_core["molecule_id"] = body["moleculeId"]
                elif body.get("编号") is not None:
                    midi_core["molecule_id"] = body["编号"]
                elif body.get("药物编号") is not None:
                    midi_core["molecule_id"] = body["药物编号"]
                rid = _next_record_id("midi")
                digest = _digest_obj(midi_core)
                out_m = {
                    "glass_delivery_kind": "midi",
                    **midi_core,
                    "pending": True,
                    "record_id": rid,
                    "ts_ingested_ms": ts_ms,
                    "receipt_digest": digest,
                }
                if midi_core.get("molecule_id") is not None:
                    out_m["编号"] = midi_core["molecule_id"]
                _enqueue_glass_session(out_m)
                self._send_json(
                    {
                        "ok": True,
                        "queued": True,
                        "glass_delivery_kind": "midi",
                        "record_id": rid,
                        "ts_ingested_ms": ts_ms,
                        "receipt_digest": digest,
                        "event_count": len(events_norm),
                    }
                )
                return

            smiles_core: dict = {"smiles": smiles}
            if body.get("编号") is not None:
                smiles_core["编号"] = body["编号"]
            rid = _next_record_id("smiles")
            digest = _digest_obj(smiles_core)
            rls = _parse_reveal_last_sec(body)
            out_s = {
                "glass_delivery_kind": "smiles",
                **smiles_core,
                "reveal_last_sec": rls,
                "record_id": rid,
                "ts_ingested_ms": ts_ms,
                "receipt_digest": digest,
            }
            mid = None
            for k in ("molecule_id", "moleculeId", "药物编号"):
                v = body.get(k)
                if v is not None and v != "":
                    mid = v
                    break
            if mid is not None:
                out_s["molecule_id"] = mid
                if out_s.get("编号") is None:
                    out_s["编号"] = mid
            _enqueue_glass_session(out_s)
            self._send_json(
                {
                    "ok": True,
                    "queued": True,
                    "glass_delivery_kind": "smiles",
                    "record_id": rid,
                    "ts_ingested_ms": ts_ms,
                    "receipt_digest": digest,
                }
            )
            return

        if path == "/__push/smiles":
            smiles = (body.get("smiles") or body.get("SMILES") or "").strip()
            if not smiles:
                self._send_json({"ok": False, "error": "missing_smiles"}, 400)
                return
            smiles_core: dict = {"smiles": smiles}
            if body.get("编号") is not None:
                smiles_core["编号"] = body["编号"]
            rid = _next_record_id("smiles")
            ts_ms = int(time.time() * 1000)
            digest = _digest_obj(smiles_core)
            row = {
                **smiles_core,
                "record_id": rid,
                "ts_ingested_ms": ts_ms,
                "receipt_digest": digest,
            }
            with _lock:
                _pending_smiles = row
            self._send_json(
                {
                    "ok": True,
                    "queued": True,
                    "record_id": rid,
                    "ts_ingested_ms": ts_ms,
                    "receipt_digest": digest,
                }
            )
            return

        if path == "/__push/midi":
            events = body.get("events") or body.get("midi_events")
            if not isinstance(events, list) or not events:
                self._send_json({"ok": False, "error": "missing_events"}, 400)
                return
            bpm = int(body.get("bpm") or 100)
            events_norm = json.loads(json.dumps(events, ensure_ascii=False))
            midi_core: dict = {"bpm": bpm, "events": events_norm}
            if body.get("molecule_id") is not None:
                midi_core["molecule_id"] = body["molecule_id"]
            elif body.get("moleculeId") is not None:
                midi_core["molecule_id"] = body["moleculeId"]
            elif body.get("编号") is not None:
                midi_core["molecule_id"] = body["编号"]
            elif body.get("药物编号") is not None:
                midi_core["molecule_id"] = body["药物编号"]
            rid = _next_record_id("midi")
            ts_ms = int(time.time() * 1000)
            digest = _digest_obj(midi_core)
            out = {
                **midi_core,
                "pending": True,
                "record_id": rid,
                "ts_ingested_ms": ts_ms,
                "receipt_digest": digest,
            }
            if midi_core.get("molecule_id") is not None:
                out["编号"] = midi_core["molecule_id"]
            with _lock:
                _pending_midi = out
            self._send_json(
                {
                    "ok": True,
                    "queued": True,
                    "count": len(events),
                    "record_id": rid,
                    "ts_ingested_ms": ts_ms,
                    "receipt_digest": digest,
                }
            )
            return

        if path == "/__push/manual_molecule_music_session":
            sid = str(body.get("session_id") or body.get("sessionId") or "").strip()
            if not sid:
                self._send_json({"ok": False, "error": "missing_session_id"}, 400)
                return
            ph = str(body.get("phase") or "generating").strip().lower()
            if ph not in ("generating", "playing", "finished"):
                ph = "generating"
            smiles_raw = (body.get("smiles") or body.get("SMILES") or "").strip()
            smiles_opt = smiles_raw if smiles_raw else None
            _manual_music_set(sid, ph, smiles_opt)
            self._send_json({"ok": True, "session_id": sid, "phase": ph})
            return

        if path == "/__push/manual_molecule_music_phase":
            sid = str(body.get("session_id") or body.get("sessionId") or "").strip()
            if not sid:
                self._send_json({"ok": False, "error": "missing_session_id"}, 400)
                return
            ph = str(body.get("phase") or "").strip().lower()
            if ph not in ("generating", "playing", "finished"):
                self._send_json({"ok": False, "error": "invalid_phase"}, 400)
                return
            _manual_music_set(sid, ph, None)
            self._send_json({"ok": True, "session_id": sid, "phase": ph})
            return

        self._send_json({"error": "not_found", "path": path}, 404)


def main():
    httpd = HTTPServer((HOST, PORT), Handler)
    print(f"[ui_poll_receiver] http://{HOST}:{PORT}/health")
    print(f"[ui_poll_receiver] GET  /api/molecule_music_ui_pending")
    print(f"[ui_poll_receiver] GET  /api/midi_exchange/ui_pending")
    print(f"[ui_poll_receiver] GET  /api/glass_session_ui_pending")
    print(f"[ui_poll_receiver] POST /__push/smiles  JSON {{\"smiles\":\"...\"}}")
    print(f"[ui_poll_receiver] POST /__push/midi    JSON {{\"events\":[...],\"bpm\":100}}")
    print(f"[ui_poll_receiver] POST /__push/glass_session  JSON {{\"smiles\":\"...\",\"events\":[...],\"bpm\":100}}")
    print(f"[ui_poll_receiver] GET  /api/manual_molecule_music_ui_status?session_id=…")
    print(f"[ui_poll_receiver] POST /__push/manual_molecule_music_session  JSON {{\"session_id\":\"…\",\"phase\":\"generating\",\"smiles\":\"…\"}}")
    print(f"[ui_poll_receiver] POST /__push/manual_molecule_music_phase  JSON {{\"session_id\":\"…\",\"phase\":\"playing|finished\"}}")
    print(f"[ui_poll_receiver] GET  /__peek/pending  （不消费队列，供监控）")
    print(f"[ui_poll_receiver] POST /__paino/log_5020_api  （映射端→5020 API 日志 → {_DEFAULT_5020_API_LOG_PATH}）")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
