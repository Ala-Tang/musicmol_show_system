from pathlib import Path
import threading
import urllib.error
import urllib.request

from flask import Flask, Response, jsonify, redirect, request, send_from_directory
from flask_cors import CORS
import json
import hashlib
import os
import subprocess
import sys
import tempfile
import traceback
from rdkit import Chem
import logging
import time
from io import BytesIO
import io as _io
from contextlib import redirect_stdout
from collections import deque

from runtime_config import DEFAULT_API_PORT, DEFAULT_UNIFIED_PORT

# PyTorch GPU 性能优化
try:
    import torch
    torch.backends.cudnn.benchmark = True
    torch.set_float32_matmul_precision('high')
    _TORCH_AVAILABLE = True
except Exception:
    _TORCH_AVAILABLE = False

_ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=str(_ROOT), static_url_path="/static")
CORS(app)
log = logging.getLogger("musicmol")
log.setLevel(logging.INFO)
# 确保有处理器
if not log.handlers:
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    log.addHandler(handler)

_PC_ROOT = _ROOT.parent.parent
_MUSIC_TO_MOLECULE_ROOT = _PC_ROOT / "packages" / "music-to-molecule"
_MOLECULE_TO_MUSIC_ROOT = _PC_ROOT / "packages" / "molecule-to-music"
# 模型权重 fallback 搜索目录（主权重在 music-to-molecule 包内）
_WORKSPACE_ROOT = _PC_ROOT / "models"
_ADMIN_DIR = _ROOT / "admin"
_EXAMPLE_MIDI_DIR = _ROOT / "sample-midi"

# 无 PyTorch 时 music_to_molecule 演示用（与 painojs/musicmol_vs/flask_api/app_v2 思路一致）
_MUSIC_TO_MOLECULE_FALLBACK_SMILES = [
    "CSC(=O)Nc1ccc(Cl)cc1OCCN(C)C",
    "COCCN1C(=O)CSC1c1ccc(Cl)cc1Cl",
    "COc1ccc(C(=O)Nc2nnc(C(F)(F)F)s2)cc1",
    "NS(=O)(=O)OCCN1CCc2ccc(Cl)cc2C1",
    "CN(C)C(=O)c1ccc(Cl)cc1Cl",
    "C#CC(=O)Nc1ccc(Br)cc1",
]

# ---------- 大屏 → 钢琴页：交互模式（接收端内存状态，进程重启后恢复默认） ----------
_PIANO_MODE_LOCK = threading.Lock()
# music_to_molecule：钢琴可弹奏；molecule_to_music：分子生成音乐展示中，钢琴端锁定
_PIANO_INTERACTION_MODE = "music_to_molecule"


def _ensure_piano_interaction_mode_molecule_to_music():
    """大屏经 molecule_submit / midi_exchange(smiles) 推送演奏队列时，同步钢琴模式为分子→音乐，避免钢琴仍停在音乐→分子 UI 锁定。"""
    global _PIANO_INTERACTION_MODE, _ext_midi_pending
    with _PIANO_MODE_LOCK:
        _PIANO_INTERACTION_MODE = "molecule_to_music"
    with _ext_midi_lock:
        _ext_midi_pending = None

# ---------- 本机/映射互斥机制 ----------
_ACCESS_MODE_LOCK = threading.Lock()
# None = 未确定, "local" = 本机模式(127.0.0.1), "remote" = 映射模式(10.70.160.25)
_ACCESS_MODE = None
_ACCESS_MODE_TIMESTAMP = 0
_ACCESS_MODE_TIMEOUT = 30  # 30秒无请求则重置

# 映射端允许的 IP 前缀
_REMOTE_IP_PREFIX = "10.70.160."


def _check_access_mode(client_ip):
    """检查并更新访问模式（已取消互斥，所有来源均可同时访问）。"""
    global _ACCESS_MODE, _ACCESS_MODE_TIMESTAMP
    with _ACCESS_MODE_LOCK:
        now = time.time()
        # 超时重置
        if _ACCESS_MODE is not None and (now - _ACCESS_MODE_TIMESTAMP) > _ACCESS_MODE_TIMEOUT:
            _ACCESS_MODE = None
        
        is_local = client_ip.startswith("127.") or client_ip == "::1"
        is_remote = client_ip.startswith(_REMOTE_IP_PREFIX)
        
        # 取消互斥：本地端和局域网映射端可以同时访问
        if is_local:
            _ACCESS_MODE = "local"
        elif is_remote:
            _ACCESS_MODE = "remote"
        else:
            _ACCESS_MODE = "other"
        _ACCESS_MODE_TIMESTAMP = now
        return True, _ACCESS_MODE


def _get_client_ip():
    """获取真实客户端 IP。"""
    if request.headers.get("X-Forwarded-For"):
        return request.headers.get("X-Forwarded-For").split(",")[0].strip()
    if request.headers.get("X-Real-Ip"):
        return request.headers.get("X-Real-Ip").strip()
    return request.remote_addr or "127.0.0.1"


# ---------- 映射端 API 访问日志 + 后台模式轮询（落地 logs/） ----------
_MAPPING_LOG_DIR = _ROOT / "logs"
_MAPPING_LOG_LOCK = threading.Lock()
# JSONL：每条一行；含来源 IP、Origin、POST 摘要、响应后内存中的钢琴模式
_MAPPING_API_LOG_PREFIXES = (
    "/api/piano_interaction_mode",
    "/api/molecule_submit",
    "/api/midi_exchange",
    "/api/molecule_music_ui",
    "/api/outbound/realtime_midi",
    "/api/music_to_molecule",
    "/api/music_to_molecule_midi",
    "/api/molecule_to_music",
)
# 映射端钢琴页轮询 GET 模式极频繁；默认同 IP 至少间隔该秒数才记一条完整日志（POST 切换指令总会记录）
try:
    _PIANO_MODE_GET_LOG_MIN_SEC = max(0.0, float((os.environ.get("MUSICMOL_MAPPING_LOG_PIANO_GET_MIN_SEC") or "12").strip()))
except ValueError:
    _PIANO_MODE_GET_LOG_MIN_SEC = 12.0
_PIANO_MODE_GET_LAST_LOG: dict[str, float] = {}


def _mapping_logs_dir_ready():
    try:
        _MAPPING_LOG_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def _mapping_should_log_path(path: str) -> bool:
    if not path.startswith("/api/") or path.startswith("/api/admin"):
        return False
    return any(path == pref or path.startswith(pref + "/") for pref in _MAPPING_API_LOG_PREFIXES)


def _mapping_snapshot_piano_mode():
    with _PIANO_MODE_LOCK:
        return _PIANO_INTERACTION_MODE


def _mapping_append_jsonl(filename: str, record: dict):
    line = json.dumps(record, ensure_ascii=False) + "\n"
    with _MAPPING_LOG_LOCK:
        try:
            _mapping_logs_dir_ready()
            with open(_MAPPING_LOG_DIR / filename, "a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception as exc:
            log.warning("mapping log append failed: %s", exc)


def _mapping_after_request(response):
    try:
        p = request.path or ""
        if not _mapping_should_log_path(p):
            return response
        if (
            _PIANO_MODE_GET_LOG_MIN_SEC > 0
            and request.method == "GET"
            and p == "/api/piano_interaction_mode"
            and response.status_code < 400
        ):
            ip = _get_client_ip()
            now = time.time()
            with _MAPPING_LOG_LOCK:
                last = _PIANO_MODE_GET_LAST_LOG.get(ip, 0.0)
                if now - last < _PIANO_MODE_GET_LOG_MIN_SEC:
                    return response
                _PIANO_MODE_GET_LAST_LOG[ip] = now
        body_summary = None
        post_mode = None
        if request.method in ("POST", "PUT", "PATCH"):
            try:
                data = request.get_json(silent=True)
                if isinstance(data, dict):
                    body_summary = {}
                    for k, v in data.items():
                        if k in ("events", "midi_events", "midi") and hasattr(v, "__len__"):
                            body_summary[k] = f"<omitted n={len(v)}>"
                        elif isinstance(v, str) and len(v) > 200:
                            body_summary[k] = v[:200] + "…"
                        else:
                            body_summary[k] = v
                    post_mode = (data.get("mode") or data.get("piano_mode") or "").strip() or None
                elif data is not None:
                    body_summary = {"_raw": str(data)[:400]}
            except Exception:
                body_summary = {"_parse_error": True}
        rec = {
            "kind": "api_access",
            "ts": time.time(),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "path": p,
            "method": request.method,
            "status": response.status_code,
            "client_ip": _get_client_ip(),
            "remote_addr": request.remote_addr,
            "forwarded_for": (request.headers.get("X-Forwarded-For") or "").strip() or None,
            "origin": request.headers.get("Origin"),
            "referer": ((request.headers.get("Referer") or "")[:500] or None),
            "user_agent": ((request.headers.get("User-Agent") or "")[:280] or None),
            "post_mode": post_mode,
            "body_summary": body_summary,
            "piano_interaction_mode_after": _mapping_snapshot_piano_mode(),
        }
        _mapping_append_jsonl("mapping_api.log", rec)
    except Exception:
        pass
    return response


def _mapping_poll_thread_main():
    try:
        poll_sec = max(3, int((os.environ.get("MUSICMOL_MAPPING_POLL_SEC") or "10").strip()))
    except ValueError:
        poll_sec = 10
    while True:
        time.sleep(poll_sec)
        try:
            _mapping_append_jsonl(
                "mapping_poll_state.log",
                {
                    "kind": "server_poll",
                    "ts": time.time(),
                    "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "piano_interaction_mode": _mapping_snapshot_piano_mode(),
                    "poll_interval_sec": poll_sec,
                },
            )
        except Exception:
            pass


def _start_mapping_background_poll():
    if (os.environ.get("MUSICMOL_MAPPING_POLL_DISABLE") or "").strip() == "1":
        return
    threading.Thread(target=_mapping_poll_thread_main, daemon=True, name="musicmol_mapping_poll").start()


# ---------- 管理监控：内存指标（进程级，重启清零） ----------
_METRICS_LOCK = threading.Lock()
_metrics = {
    "started_at": time.time(),
    "counts": {},
    "activity": deque(maxlen=150),
}
_series = deque(maxlen=200)

_METRIC_API_BASES = {
    "/api/music_to_molecule": "music_to_molecule",
    "/api/music_to_molecule_midi": "music_to_molecule_midi",
    "/api/molecule_to_music": "molecule_to_music",
    "/api/molecule_submit": "molecule_submit",
    "/api/molecule_music_ui_dismiss": "molecule_music_ui_dismiss",
    "/api/midi_exchange": "midi_exchange",
    "/api/midi_exchange/ui_dismiss": "midi_exchange_ui_dismiss",
    "/api/children_midi_manifest": "children_midi_manifest",
    "/api/outbound/realtime_midi": "outbound_realtime_midi",
    "/api/outbound/smiles": "outbound_smiles",
    "/api/play_example_midi": "play_example_midi",
}
_METRICS_SKIP_ACTIVITY = frozenset({
    "/api/status_lite",
    "/api/piano_interaction_mode",
    "/api/molecule_music_ui_pending",
    "/api/midi_exchange/ui_pending",
    "/api/molecule_queue_state",
    "/api/outbound/realtime_midi",
})


def _admin_token_ok():
    expected = (os.environ.get("MUSICMOL_ADMIN_TOKEN") or "musicmol-admin-change-me").strip()
    got = (request.headers.get("X-Admin-Token") or request.args.get("token") or "").strip()
    return bool(got) and got == expected


def _metrics_after_request(response):
    try:
        p = request.path or ""
        if not p.startswith("/api/") or p.startswith("/api/admin"):
            return response
        code = response.status_code
        if p == "/api/status_lite":
            with _METRICS_LOCK:
                c = _metrics["counts"]
                c["status_lite_polls"] = c.get("status_lite_polls", 0) + 1
            return response
        if p == "/api/molecule_queue_state":
            with _METRICS_LOCK:
                c = _metrics["counts"]
                c["queue_state_polls"] = c.get("queue_state_polls", 0) + 1
            return response
        if p in _METRICS_SKIP_ACTIVITY:
            return response
        base = _METRIC_API_BASES.get(p)
        if base:
            suf = "ok" if code < 400 else "err"
            key = f"{base}_{suf}"
            with _METRICS_LOCK:
                c = _metrics["counts"]
                c[key] = c.get(key, 0) + 1
                _metrics["activity"].append(
                    {
                        "t": time.time(),
                        "path": p,
                        "method": request.method,
                        "status": code,
                    }
                )
        else:
            with _METRICS_LOCK:
                c = _metrics["counts"]
                c["api_other"] = c.get("api_other", 0) + 1
    except Exception:
        pass
    return response


app.after_request(_metrics_after_request)
app.after_request(_mapping_after_request)


@app.before_request
def _access_mode_check():
    """本机/映射互斥检查。"""
    # 跳过静态资源和部分 API
    if request.path.startswith("/static/"):
        return None
    if request.path in [
        "/health",
        "/api/status_lite",
        "/api/admin/snapshot",
        "/api/molecule_submit",
    ]:
        return None
    
    client_ip = _get_client_ip()
    ok, mode = _check_access_mode(client_ip)
    if not ok:
        mode_str = "本机模式" if mode == "local" else "映射模式"
        return jsonify({
            "ok": False,
            "error": f"当前处于{mode_str}，请关闭另一端的页面后重试。",
            "mode": mode,
            "your_ip": client_ip
        }), 403
    return None


_start_mapping_background_poll()


# ---------- 对外推送：对接 ui_poll_receiver（默认基址 8082，无尾斜杠） ----------
# - 本项目监听：优先环境变量 MUSICMOL_LISTEN_HOST；未设时 MUSICMOL_BIND_REMOTE=1 则 0.0.0.0，否则 127.0.0.1
#   与 MUSICMOL_LISTEN_PORT（缺省 5020）
# - 外发基址 MUSICMOL_OUTBOUND_BASE：请由 start_flask.sh 按当前网卡 IP 注入；直接 python app.py 且未设 env 时缺省 http://127.0.0.1:8082
#   SMILES -> POST {BASE}/__push/smiles：仅当 music_to_molecule* 请求带 push_outbound_smiles，
#     或显式 POST /api/outbound/smiles（勿在仅实时弹奏路径外发 SMILES）
#   MIDI   -> POST {BASE}/__push/midi    请求体含 events[]，start/duration 毫秒
# - 可选整 URL 覆盖：MUSICMOL_OUTBOUND_SMILES_URL / MUSICMOL_OUTBOUND_MIDI_PUSH_URL（须含路径）
# 设 MUSICMOL_OUTBOUND_ENABLE=0 关闭外发

_RT_PUSH_LOCK = threading.Lock()
_RT_NOTE_ON_STACK = {}  # midi_note -> list of start_ms（同音连击用栈）
_OUTBOUND_MON_LOCK = threading.Lock()
_outbound_mon = {
    "realtime_midi": {"await_note_off": 0, "relayed_ok": 0, "relayed_err": 0, "orphan_note_off": 0},
    "smiles_push": {"ok": 0, "err": 0},
    "midi_push": {"ok": 0, "err": 0},
    "last": {},
}


def _record_outbound_event(channel: str, ok: bool, detail: dict | None = None):
    with _OUTBOUND_MON_LOCK:
        if channel == "smiles_push":
            k = "ok" if ok else "err"
            _outbound_mon["smiles_push"][k] = _outbound_mon["smiles_push"].get(k, 0) + 1
        elif channel == "midi_push":
            k = "ok" if ok else "err"
            _outbound_mon["midi_push"][k] = _outbound_mon["midi_push"].get(k, 0) + 1
        _outbound_mon["last"][channel] = {"t": time.time(), "ok": bool(ok), **(detail or {})}


def _outbound_relay_enabled() -> bool:
    return (os.environ.get("MUSICMOL_OUTBOUND_ENABLE", "1") or "1").strip() != "0"


def _truthy_push_outbound_smiles(val) -> bool:
    """
    是否在本次「音乐→分子」推理成功后向 8082 POST __push/smiles。
    默认不推送：仅弹奏、探活调用 inference 时不应外发 SMILES；由前端在「生成分子」等显式场景传 true。
    """
    if val is True:
        return True
    if isinstance(val, (int, float)) and int(val) == 1:
        return True
    if isinstance(val, str) and val.strip().lower() in ("1", "true", "yes", "on"):
        return True
    return False


def _outbound_base() -> str:
    """外发接收端基址；换网口后由启动脚本写入 MUSICMOL_OUTBOUND_BASE=http://<当前局域网IP>:8082。"""
    return (os.environ.get("MUSICMOL_OUTBOUND_BASE") or "http://127.0.0.1:8082").rstrip("/")


def _outbound_smiles_push_url() -> str:
    u = (os.environ.get("MUSICMOL_OUTBOUND_SMILES_URL") or "").strip()
    if u:
        return u
    if not _outbound_relay_enabled():
        return ""
    return f"{_outbound_base()}/__push/smiles"


def _outbound_midi_push_url() -> str:
    u = (os.environ.get("MUSICMOL_OUTBOUND_MIDI_PUSH_URL") or "").strip()
    if not u:
        u = (os.environ.get("MUSICMOL_OUTBOUND_REALTIME_MIDI_URL") or "").strip()
    if u:
        return u
    if not _outbound_relay_enabled():
        return ""
    return f"{_outbound_base()}/__push/midi"


def _outbound_env_url(key: str) -> str:
    return (os.environ.get(key) or "").strip()


def _outbound_auth_headers() -> dict:
    tok = (os.environ.get("MUSICMOL_OUTBOUND_TOKEN") or "").strip()
    if not tok:
        return {}
    return {"Authorization": f"Bearer {tok}"}


def _http_post_json(target_url: str, payload: dict, timeout_sec: float = 4.0):
    """POST JSON 到外部 URL。返回 (success, error_hint)。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        target_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            **_outbound_auth_headers(),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            resp.read(65536)
        return True, None
    except urllib.error.HTTPError as e:
        return False, f"http_{e.code}"
    except Exception as exc:
        return False, str(exc)[:200]


def _relay_smiles_after_inference(best_smiles: str, meta: dict, source: str) -> None:
    """在调用方确认需要外发时，向接收端发送 SMILES（不抛异常）。"""
    if not _outbound_relay_enabled() or not best_smiles:
        return
    url = _outbound_smiles_push_url()
    if not url:
        return
    pl = {"smiles": str(best_smiles).strip()}
    if isinstance(meta, dict):
        bid = meta.get("编号") or meta.get("molecule_id") or meta.get("moleculeId") or meta.get("药物编号")
        if bid is not None and str(bid).strip() != "":
            pl["编号"] = bid
    ok, err = _http_post_json(url, pl, timeout_sec=5.0)
    if not ok:
        _record_outbound_event("smiles_push", False, {"source": source, "error": err, "url": url})
        log.warning("outbound SMILES push failed (%s): %s", source, err)
    else:
        _record_outbound_event("smiles_push", True, {"source": source, "url": url})


def _relay_phase_to_painojs(session_id: str, phase: str, smiles: str | None = None) -> tuple:
    """向 PAINOJS (8082) 发送分子音乐演奏阶段状态（generating/playing/finished）。
    
    用于第二种方式（分子生成音乐模式）的状态同步：
    - generating: AI 计算中
    - playing: 开始自动演奏
    - finished: 演奏结束
    
    返回 (success, error_hint)。
    """
    if not _outbound_relay_enabled() or not session_id:
        return True, None
    url = f"{_outbound_base()}/__push/manual_molecule_music_phase"
    pl = {"session_id": session_id, "phase": phase}
    if smiles is not None:
        pl["smiles"] = smiles
    ok, err = _http_post_json(url, pl, timeout_sec=3.0)
    if not ok:
        log.warning("phase relay failed: %s -> %s, err=%s", phase, url, err)
    return ok, err


def _relay_midi_events_to_push(events: list, bpm: int = 100) -> tuple:
    """POST 到接收端 __push/midi；events 为 [{note,start,duration}, ...] 毫秒。"""
    if not _outbound_relay_enabled() or not events:
        return True, None
    url = _outbound_midi_push_url()
    if not url:
        return True, None
    try:
        bpm = int(bpm)
    except Exception:
        bpm = 100
    bpm = max(40, min(240, bpm))
    pl = {"bpm": bpm, "events": events}
    ok, err = _http_post_json(url, pl, timeout_sec=3.0)
    if not ok:
        _record_outbound_event("midi_push", False, {"error": err, "url": url, "event_count": len(events)})
    else:
        _record_outbound_event("midi_push", True, {"url": url, "event_count": len(events)})
    return ok, err


def _relay_midi_to_glass_session(events: list, bpm: int = 100) -> tuple:
    """POST 到接收端 __push/glass_session（full 形态，events + 占位 smiles）。"""
    if not _outbound_relay_enabled() or not events:
        return True, None
    url = f"{_outbound_base()}/__push/glass_session"
    try:
        bpm = int(bpm)
    except Exception:
        bpm = 100
    bpm = max(40, min(240, bpm))
    pl = {"smiles": "pending", "bpm": bpm, "reveal_last_sec": 5, "events": events}
    ok, err = _http_post_json(url, pl, timeout_sec=3.0)
    if not ok:
        _record_outbound_event("midi_push", False, {"error": err, "url": url, "event_count": len(events), "target": "glass_session"})
    else:
        _record_outbound_event("midi_push", True, {"url": url, "event_count": len(events), "target": "glass_session"})
    return ok, err


def _mido_note_events_from_file(midi_path, *, time_key="time", include_type=True, min_duration=50):
    """
    将 MIDI 文件解析为前端播放事件。
    同一音高允许重叠：Cython 生成器会产生 overlap，不能用单个 active_notes[note]
    记录 onset，否则连续相同音高会互相覆盖，导致不同分子旋律被截短得很相似。
    """
    import mido

    mid = mido.MidiFile(midi_path)
    merged = mido.merge_tracks(mid.tracks)
    tempo = 500000
    ticks_per_beat = mid.ticks_per_beat
    events = []
    active_notes = {}
    current_time_ms = 0.0
    for msg in merged:
        current_time_ms += mido.tick2second(msg.time, ticks_per_beat, tempo) * 1000.0
        if msg.type == 'set_tempo':
            tempo = msg.tempo
        elif msg.type == 'note_on' and msg.velocity > 0:
            active_notes.setdefault(msg.note, []).append(
                {'time_ms': current_time_ms, 'velocity': msg.velocity}
            )
        elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
            stack = active_notes.get(msg.note)
            if stack:
                start = stack.pop(0)
                if not stack:
                    active_notes.pop(msg.note, None)
                ev = {
                    time_key: round(start['time_ms']),
                    'note': msg.note,
                    'duration': max(min_duration, round(current_time_ms - start['time_ms'])),
                    'velocity': start['velocity'],
                }
                if include_type:
                    ev['type'] = 'noteOn'
                events.append(ev)
    events.sort(key=lambda e: e[time_key])
    return events


def _generate_midi_events_from_smiles(smiles, bpm):
    """
    使用 分子到音乐 模块将 SMILES 转换为 MIDI 事件数组。
    使用 Cython 模块 smile_to_midi_v10；失败时直接返回 None。
    返回 [{time, type, note, duration, velocity}] 或 None（失败时）。
    """
    import mido

    if _MOLECULE_TO_MUSIC_ROOT.exists():
        core_path = str(_MOLECULE_TO_MUSIC_ROOT)
        inserted = False
        if core_path not in sys.path:
            sys.path.insert(0, core_path)
            inserted = True
        try:
            import smile_to_midi_v10
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as f:
                    tmp_path = f.name
                with redirect_stdout(_io.StringIO()):
                    smile_to_midi_v10.smiles_to_midi(smiles, tmp_path, tempo_bpm=int(bpm))
                return _mido_note_events_from_file(
                    tmp_path,
                    time_key="time",
                    include_type=True,
                    min_duration=50,
                )
            finally:
                if tmp_path:
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass
        except Exception as exc:
            log.warning("Cython 模块 smile_to_midi_v10 失败: %s", exc, exc_info=True)
        finally:
            if inserted and sys.path and sys.path[0] == core_path:
                sys.path.pop(0)

    return None


def _events_to_midi_file(events, bpm, midi_path):
    """
    将前端事件列表写为标准 MIDI 文件。
    events: [{note:int, start|time:int(ms), duration:int(ms)}]
    """
    try:
        import mido
    except Exception as exc:
        raise RuntimeError("缺少依赖 mido，请先安装：pip install mido") from exc

    if not isinstance(events, list) or not events:
        raise ValueError("events 为空，无法生成 MIDI")
    bpm = int(max(40, min(240, int(bpm or 100))))
    ticks_per_beat = 480
    tempo = mido.bpm2tempo(bpm)
    track_events = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        note = int(ev.get("note", -1))
        if note < 0 or note > 127:
            continue
        start_ms = ev.get("start", ev.get("time", 0))
        dur_ms = ev.get("duration", 200)
        try:
            start_ms = max(0, int(start_ms))
            dur_ms = max(40, int(dur_ms))
        except Exception:
            continue
        track_events.append(("on", start_ms, note, 90))
        track_events.append(("off", start_ms + dur_ms, note, 0))

    if not track_events:
        raise ValueError("events 中无有效音符")
    track_events.sort(key=lambda x: (x[1], 0 if x[0] == "off" else 1))

    mid = mido.MidiFile(ticks_per_beat=ticks_per_beat)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    track.append(mido.Message("program_change", program=0, time=0))
    last_ms = 0
    for typ, abs_ms, note, velocity in track_events:
        delta_ms = max(0, abs_ms - last_ms)
        delta_ticks = mido.second2tick(delta_ms / 1000.0, ticks_per_beat, tempo)
        delta_ticks = int(round(delta_ticks))
        if typ == "on":
            track.append(mido.Message("note_on", note=note, velocity=velocity, time=delta_ticks))
        else:
            track.append(mido.Message("note_off", note=note, velocity=velocity, time=delta_ticks))
        last_ms = abs_ms
    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(midi_path)


def _midi_file_to_events(midi_path):
    """
    将 MIDI 文件解析为标准化事件数组。
    返回 [{note:int, start:int(ms), duration:int(ms)}]
    """
    return _mido_note_events_from_file(
        midi_path,
        time_key="start",
        include_type=False,
        min_duration=40,
    )


def _events_list_to_note_sequence(events) -> list:
    """从 API / MIDI 解析事件列表提取 note 序列（用于无 torch 时的演示映射）。"""
    notes = []
    if not isinstance(events, list):
        return notes
    for ev in events:
        if not isinstance(ev, dict):
            continue
        try:
            notes.append(int(ev.get("note", 0)))
        except Exception:
            continue
    return notes


def _music_to_mol_exc_should_demo_fallback(exc: BaseException) -> bool:
    """缺少依赖或 Transformer 推理链异常时，用演示 SMILES 兜底，避免钢琴页长期 500。"""
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        return True
    msg = str(exc).lower()
    if "torch" in msg or "inference" in msg:
        return True
    if "selfies" in msg and "no module" in msg:
        return True
    return False


def _music_to_molecule_response_dict(result: dict, infer_ms: int, events_count: int, bpm: int) -> dict:
    """构造 /api/music_to_molecule* 成功响应体（与路由内字段保持一致）。"""
    meta = {
        "qed": result["best"].get("qed") if isinstance(result["best"], dict) else None,
        "canonical_smiles": result["best"].get("canonical_smiles") if isinstance(result["best"], dict) else None,
        "event_count": events_count,
        "bpm": bpm,
        "inference_time_ms": infer_ms,
    }
    summ = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    if summ.get("mode") == "demo_fallback_no_torch":
        meta["engine"] = "demo_fallback"
    else:
        meta["engine"] = "transformer"
    return {"ok": True, "best_smiles": result["best_smiles"], "meta": meta}


def _fallback_music_to_smiles_result_from_notes(note_seq: list) -> dict:
    """
    未安装 PyTorch 或无法加载 inference 时：按音符序列哈希映射到预置 SMILES，
    返回结构与 _run_transformer_from_midi_path 一致，供 JSON / multipart 两路接口复用。
    """
    if not note_seq:
        digest = hashlib.md5(b"musicmol_empty_performance").hexdigest()
    else:
        digest = hashlib.md5(",".join(map(str, note_seq)).encode("utf-8")).hexdigest()
    idx = int(digest[:8], 16) % len(_MUSIC_TO_MOLECULE_FALLBACK_SMILES)
    raw_smiles = _MUSIC_TO_MOLECULE_FALLBACK_SMILES[idx]
    canon = raw_smiles
    qed_val = None
    try:
        mol = Chem.MolFromSmiles(raw_smiles)
        if mol:
            canon = Chem.MolToSmiles(mol)
            from rdkit.Chem import QED

            qed_val = round(float(QED.qed(mol)), 4)
    except Exception:
        pass
    best = {
        "canonical_smiles": canon,
        "pred_smiles": raw_smiles,
        "qed": qed_val,
    }
    return {
        "best_smiles": canon,
        "best": best,
        "beams": [],
        "summary": {
            "mode": "demo_fallback_no_torch",
            "source": "hash_note_sequence",
            "torch_available": False,
        },
    }


def _find_example_midi_file(filename_or_song_key):
    """
    根据文件名或 song_key 查找示例 MIDI 文件。
    匹配优先级：
    1. 完整文件名匹配（如 "03_生日快乐_Happy_Birthday.mid"）
    2. 自动加 .mid 后缀匹配
    3. song_key 精确匹配（去掉序号前缀后的名称）
    4. 模糊匹配（仅当结果唯一时接受）
    返回 Path 或 None。
    """
    import re
    if not _EXAMPLE_MIDI_DIR.exists():
        return None
    files = list(_EXAMPLE_MIDI_DIR.glob("*.mid"))
    if not files:
        return None
    query = str(filename_or_song_key).strip()
    if not query:
        return None
    # 1. 完整文件名匹配
    for f in files:
        if f.name == query:
            return f
    # 2. 自动加 .mid 后缀
    for f in files:
        if f.name == query + ".mid":
            return f
    # 3. song_key 精确匹配
    for f in files:
        stem = f.name[:-4] if f.name.endswith(".mid") else f.name
        sk = re.sub(r"^\d+_", "", stem)
        if sk == query or stem == query:
            return f
    # 4. 模糊匹配（仅唯一结果）
    matches = []
    for f in files:
        stem = f.name[:-4] if f.name.endswith(".mid") else f.name
        sk = re.sub(r"^\d+_", "", stem)
        if query.lower() in f.name.lower() or query.lower() in sk.lower():
            matches.append(f)
    if len(matches) == 1:
        return matches[0]
    return None


def _music_mol_infer_beam_size() -> int:
    """实时推理 beam 宽度，默认 8（原 20 过慢）。环境变量 MUSICMOL_BEAM_SIZE。"""
    try:
        v = int((os.environ.get("MUSICMOL_BEAM_SIZE") or "8").strip())
    except ValueError:
        v = 8
    return max(1, min(32, v))


def _music_mol_infer_num_return() -> int:
    """beam 候选数上限，默认 8。环境变量 MUSICMOL_NUM_RETURN。"""
    try:
        v = int((os.environ.get("MUSICMOL_NUM_RETURN") or "8").strip())
    except ValueError:
        v = 8
    return max(1, min(32, v))


def _music_mol_inference_device() -> str:
    """
    音乐→分子 Transformer 设备。无可用 GPU 时必须使用 cpu，否则 run_inference 会报
    “No CUDA GPUs are available”，映射端点击「生成分子」无结果。
    环境变量 MUSICMOL_INFERENCE_DEVICE: auto（默认）| cpu | cuda
    """
    explicit = (os.environ.get("MUSICMOL_INFERENCE_DEVICE") or "").strip().lower()
    if explicit == "cpu":
        return "cpu"
    if explicit == "cuda":
        if _TORCH_AVAILABLE and torch.cuda.is_available():
            return "cuda"
        log.warning("MUSICMOL_INFERENCE_DEVICE=cuda 但当前无可用 CUDA，已退回 cpu")
        return "cpu"
    if not _TORCH_AVAILABLE:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_predictions_jsonl(pred_path):
    rows = []
    if not pred_path.exists():
        return rows
    with pred_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def _run_transformer_from_midi_path(midi_path: Path, sample_id: str = "live"):
    """
    对已写入磁盘的 MIDI 文件运行音乐→分子推理（与 notebook / jsonl 管线一致）。
    midi_path 须在调用期间保持可读。

    除「未安装 torch」外，部分环境会出现 app 顶层已 import torch，但「音乐到分子/inference」
    子模块再 import torch 仍失败等情况；凡无法加载 inference.run_inference 时一律回退演示 SMILES，
    避免钢琴端长期报「导入 inference…失败」而无法出结果。
    """

    def _fallback_from_midi_file() -> dict:
        try:
            evs = _midi_file_to_events(midi_path)
        except Exception as exc:
            log.warning("演示 SMILES：解析 MIDI 失败: %s", exc)
            evs = []
        seq = _events_list_to_note_sequence(evs)
        return _fallback_music_to_smiles_result_from_notes(seq)

    if not _TORCH_AVAILABLE:
        return _fallback_from_midi_file()

    run_inference_fn = None
    sys.path.insert(0, str(_MUSIC_TO_MOLECULE_ROOT))
    try:
        from inference import run_inference as run_inference_fn
    except Exception as exc:
        log.warning(
            "导入 inference.run_inference 失败，使用演示 SMILES（请检查 torch 与 音乐到分子 依赖）：%s",
            exc,
        )
        run_inference_fn = None
    finally:
        if sys.path and sys.path[0] == str(_MUSIC_TO_MOLECULE_ROOT):
            sys.path.pop(0)

    if run_inference_fn is None:
        return _fallback_from_midi_file()

    ckpt_candidates = [
        _MUSIC_TO_MOLECULE_ROOT / "model_last(2).pt",
        _MUSIC_TO_MOLECULE_ROOT / "model_last.pt",
        _WORKSPACE_ROOT / "model_last(2).pt",
        _WORKSPACE_ROOT / "model_last.pt",
    ]
    cfg_candidates = [
        _MUSIC_TO_MOLECULE_ROOT / "config.json",
        _WORKSPACE_ROOT / "config.json",
    ]
    ckpt = next((p for p in ckpt_candidates if p.exists()), None)
    cfg = next((p for p in cfg_candidates if p.exists()), None)
    if not _MUSIC_TO_MOLECULE_ROOT.exists():
        raise RuntimeError("未找到目录：音乐到分子")
    if ckpt is None:
        raise RuntimeError("缺少 model_last.pt 或 model_last(2).pt，请先按 readme 下载模型权重")
    if cfg is None:
        raise RuntimeError("缺少 config.json，无法加载推理配置")

    try:
        with tempfile.TemporaryDirectory(prefix="music_to_mol_") as td:
            td_path = Path(td)
            input_list = td_path / "input.jsonl"
            output_dir = td_path / "output_beam_qed"
            abs_midi = str(midi_path.resolve())
            with input_list.open("w", encoding="utf-8") as f:
                f.write(json.dumps({"id": sample_id, "midi_path": abs_midi}, ensure_ascii=False) + "\n")

            ctx = torch.inference_mode if _TORCH_AVAILABLE else lambda: __import__('contextlib').nullcontext()
            dev = _music_mol_inference_device()
            beam_n = _music_mol_infer_beam_size()
            ret_n = _music_mol_infer_num_return()
            with ctx():
                records, summary = run_inference_fn(
                    config_path=str(cfg),
                    ckpt_path=str(ckpt),
                    input_list=str(input_list),
                    output_dir=str(output_dir),
                    batch_size=1,
                    seed=42,
                    beam_size=beam_n,
                    num_return_sequences=ret_n,
                    repeat_token_penalty=0,
                    device=dev,
                    save_outputs=False,
                )

            pred_rows = []
            if isinstance(records, list) and records:
                pred_rows = records
            else:
                pred_rows = _load_predictions_jsonl(output_dir / "predictions_topk.jsonl")

            if not pred_rows:
                raise RuntimeError("推理完成但未产出预测结果")
            first = pred_rows[0] if isinstance(pred_rows[0], dict) else {}
            best = first.get("best") if isinstance(first.get("best"), dict) else {}
            best_smiles = (best.get("canonical_smiles") or best.get("pred_smiles") or "").strip()
            if not best_smiles:
                raise RuntimeError("未得到合法 best SMILES")
            beams = first.get("beams") if isinstance(first.get("beams"), list) else []
            return {
                "best_smiles": best_smiles,
                "best": best,
                "beams": beams,
                "summary": summary if isinstance(summary, dict) else {},
            }
    except Exception as exc:
        log.warning(
            "Transformer 流水线异常，已回退演示 SMILES：%s",
            exc,
            exc_info=log.isEnabledFor(logging.DEBUG),
        )
        return _fallback_from_midi_file()


def _run_transformer_music_to_smiles(events, bpm):
    """
    严格对齐 @音乐到分子 notebook:
    run_inference(config_path, ckpt_path, input_list, output_dir, batch_size=4, seed=42,
                  beam_size=32, num_return_sequences=20, repeat_token_penalty=0)
    """
    if not _TORCH_AVAILABLE:
        seq = _events_list_to_note_sequence(events)
        return _fallback_music_to_smiles_result_from_notes(seq)

    try:
        with tempfile.TemporaryDirectory(prefix="music_to_mol_") as td:
            td_path = Path(td)
            midi_path = td_path / "input.mid"
            _events_to_midi_file(events, bpm, str(midi_path))
            return _run_transformer_from_midi_path(midi_path, "live_piano")
    except Exception as exc:
        if _music_to_mol_exc_should_demo_fallback(exc):
            log.warning("events→MIDI 或推理链异常，回退演示 SMILES：%s", exc, exc_info=True)
            seq = _events_list_to_note_sequence(events)
            return _fallback_music_to_smiles_result_from_notes(seq)
        raise


@app.route("/health", methods=["GET", "HEAD"])
def api_health():
    """
    PAINOJS / 映射端探活（见 painojs/js/paino/stack/musicMolPartnerHealth.js）；
    无推理、不读写队列；须可走映射 ACL（before_request 已放行）。
    """
    return jsonify({"ok": True, "service": "musicmol"}), 200


@app.route("/api/status_lite", methods=["GET"])
def api_status_lite():
    """
    轻量状态：不加载模型、不跑推理，仅供前端状态灯轮询。
    （勿用 POST /api/music_to_molecule 做心跳：会触发完整 Transformer 推理，耗数秒且误显「连接中」。）
    """
    ckpt_ok = any(
        p.exists()
        for p in (
            _MUSIC_TO_MOLECULE_ROOT / "model_last(2).pt",
            _MUSIC_TO_MOLECULE_ROOT / "model_last.pt",
            _WORKSPACE_ROOT / "model_last(2).pt",
            _WORKSPACE_ROOT / "model_last.pt",
        )
    )
    cfg_ok = any(
        p.exists()
        for p in (_MUSIC_TO_MOLECULE_ROOT / "config.json", _WORKSPACE_ROOT / "config.json")
    )
    music_to_molecule_ready = bool(_MUSIC_TO_MOLECULE_ROOT.exists() and ckpt_ok and cfg_ok)
    molecule_to_music_ready = bool(_MOLECULE_TO_MUSIC_ROOT.exists())
    return jsonify({
        "ok": True,
        "music_to_molecule": music_to_molecule_ready or (not _TORCH_AVAILABLE),
        "molecule_to_music": molecule_to_music_ready,
        "music_to_molecule_engine": "transformer" if _TORCH_AVAILABLE else "demo_fallback",
    })


@app.route("/api/piano_interaction_mode", methods=["GET", "POST", "OPTIONS"])
def api_piano_interaction_mode():
    """
    钢琴页交互模式（供大屏等外部系统写入，本页轮询 GET）。

    - music_to_molecule：音乐生成分子 — 钢琴端全部可操作。
    - molecule_to_music：分子生成音乐 — 钢琴端锁定，仅展示模式文案。

    POST JSON: {\"mode\": \"music_to_molecule\" | \"molecule_to_music\"}
    """
    global _PIANO_INTERACTION_MODE, _ext_midi_pending
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "GET":
        with _PIANO_MODE_LOCK:
            m = _PIANO_INTERACTION_MODE
        return jsonify({"ok": True, "mode": m})

    data = request.get_json(silent=True) or {}
    mode = (data.get("mode") or data.get("piano_mode") or "").strip()
    if mode not in ("music_to_molecule", "molecule_to_music"):
        return jsonify({"ok": False, "error": "mode 须为 music_to_molecule 或 molecule_to_music"}), 400
    with _PIANO_MODE_LOCK:
        _PIANO_INTERACTION_MODE = mode
    if mode == "molecule_to_music":
        with _ext_midi_lock:
            _ext_midi_pending = None
    return jsonify({"ok": True, "mode": mode})


# ============ 接口：分子到音乐 ============

@app.route("/api/molecule_to_music", methods=["POST"])
def api_molecule_to_music():
    """
    分子到音乐：输入 SMILES，返回 MIDI 事件数组。
    请求 JSON: { "smiles": str, "bpm": int 可选，默认 100，范围 40–240 }
    响应 JSON: { "ok": true, "midi_events": [...], "meta": {...} }
    """
    data = request.get_json(silent=True) or {}
    smiles = (data.get("smiles") or "").strip()
    bpm_raw = data.get("bpm", 100)
    try:
        bpm = int(bpm_raw)
    except (TypeError, ValueError):
        bpm = 100
    bpm = max(40, min(240, bpm))

    if not smiles:
        return jsonify({"ok": False, "error": "SMILES 为空"}), 400

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return jsonify({"ok": False, "error": "RDKit 无法解析该 SMILES"}), 400

    midi_events = _generate_midi_events_from_smiles(smiles, bpm)
    if not midi_events:
        return jsonify({"ok": False, "error": "MIDI 事件生成失败"}), 500

    return jsonify({
        "ok": True,
        "midi_events": midi_events,
        "meta": {
            "smiles": smiles,
            "canonical_smiles": Chem.MolToSmiles(mol),
            "bpm": bpm,
            "event_count": len(midi_events),
            "num_atoms": mol.GetNumAtoms(),
            "num_heavy_atoms": mol.GetNumHeavyAtoms(),
        }
    })


# ============ 接口：音乐到分子 ============

@app.route("/api/music_to_molecule", methods=["POST"])
def api_music_to_molecule():
    """
    音乐到分子：输入 MIDI 事件片段，返回最佳 SMILES。
    支持实时流式发送：前端可随时发送最新片段，后端立即推理。
    请求 JSON: { "events": [...], "bpm": int 可选,
                  "push_outbound_smiles": bool 可选 }
    仅当 push_outbound_smiles 为真时，推理成功后才 POST {BASE}/__push/smiles（避免仅弹奏/探活误发 SMILES）。
    响应 JSON: { "ok": true, "best_smiles": str, "meta": {...} }
    """
    data = request.get_json(silent=True) or {}
    events = data.get("events")
    bpm = data.get("bpm", 100)

    if not isinstance(events, list) or not events:
        return jsonify({"ok": False, "error": "events 为空，无法推理"}), 400

    try:
        t0 = time.time()
        result = _run_transformer_music_to_smiles(events, bpm)
        infer_ms = int((time.time() - t0) * 1000)
        log.info(
            "music_to_molecule ok: events=%s bpm=%s inference_ms=%s",
            len(events),
            bpm,
            infer_ms,
        )
        return jsonify(_music_to_molecule_response_dict(result, infer_ms, len(events), bpm)), 200
    except Exception as exc:
        if _music_to_mol_exc_should_demo_fallback(exc):
            try:
                t1 = time.time()
                result = _fallback_music_to_smiles_result_from_notes(_events_list_to_note_sequence(events))
                infer_ms = int((time.time() - t1) * 1000)
                log.warning("music_to_molecule 接口兜底演示 SMILES（此前异常：%s）", exc)
                return jsonify(_music_to_molecule_response_dict(result, infer_ms, len(events), bpm)), 200
            except Exception as exc2:
                exc = exc2
        log.error("music_to_molecule failed: %s\n%s", exc, traceback.format_exc())
        return jsonify({"ok": False, "error": str(exc)}), 500


# ============ 分子结果队列（供外部轮询 / 联调） ============

_MOLECULE_SUBMIT_LOCK = threading.Lock()
_molecule_queue = {"seq": 0, "last": None}

# 接口推送 SMILES 后：分子→音乐生成 MIDI，供大屏确认演奏
_MOL_MUSIC_UI_LOCK = threading.Lock()
_mol_music_ui_pending = None
# 自动演奏状态跟踪：seq -> {"started_at": timestamp, "session_id": str}
_MOL_MUSIC_AUTOPLAY_STATE = {}
_MOL_MUSIC_AUTOPLAY_TIMEOUT = 300  # 5分钟后自动清理状态


def _enqueue_molecule_music_from_request(data: dict, log_source: str):
    """
    分子→音乐：仅凭 SMILES 调用「分子到音乐」生成 MIDI 并入队（供 molecule_music_ui_pending 轮询）。
    请求体可含 bpm、auto_play、session_id；若同时携带 events / midi_events，仍不参与演奏，仅走 SMILES 计算。
    返回 (dict, http_status)。
    """
    global _mol_music_ui_pending

    smiles = (data.get("smiles") or "").strip()
    if not smiles:
        return {"ok": False, "error": "SMILES 为空"}, 400
    try:
        bpm = int(data.get("bpm", 100))
    except (TypeError, ValueError):
        bpm = 100
    bpm = max(40, min(240, bpm))

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {"ok": False, "error": "RDKit 无法解析该 SMILES"}, 400

    midi_events = _generate_midi_events_from_smiles(smiles, bpm)

    with _MOLECULE_SUBMIT_LOCK:
        _molecule_queue["seq"] = int(_molecule_queue.get("seq", 0)) + 1
        _molecule_queue["last"] = {"smiles": smiles, "bpm": bpm}
        seq = _molecule_queue["seq"]

    log.info(
        "%s: molecule music enqueue, seq=%s, events=%s",
        log_source,
        seq,
        len(midi_events) if midi_events else 0,
    )

    auto_play = _truthy_push_outbound_smiles(data.get("auto_play"))
    session_id = data.get("session_id") or str(seq)

    _relay_phase_to_painojs(session_id, "generating", smiles)

    if midi_events:
        with _MOL_MUSIC_UI_LOCK:
            _mol_music_ui_pending = {
                "seq": seq,
                "smiles": smiles,
                "canonical_smiles": Chem.MolToSmiles(mol),
                "bpm": bpm,
                "midi_events": midi_events,
                "session_id": session_id,
                "auto_play": auto_play,
                "submitted_at": time.time(),
            }
            if auto_play:
                _MOL_MUSIC_AUTOPLAY_STATE[session_id] = {
                    "seq": seq,
                    "started_at": time.time(),
                    "status": "pending",
                }

        _relay_phase_to_painojs(session_id, "playing", smiles)

        glass_events = [
            {"note": e["note"], "start": e["time"], "duration": e["duration"]}
            for e in midi_events
        ]
        ok_relay, err_relay = _relay_midi_to_glass_session(glass_events, bpm)
        if not ok_relay:
            log.warning("%s: 发送到 8082 失败: %s", log_source, err_relay)
    else:
        with _MOL_MUSIC_UI_LOCK:
            _mol_music_ui_pending = None
        _relay_phase_to_painojs(session_id, "finished", smiles)

    _ensure_piano_interaction_mode_molecule_to_music()
    return {
        "ok": True,
        "seq": seq,
        "has_midi": bool(midi_events),
        "midi_events": midi_events or [],
        "midi_event_count": len(midi_events) if midi_events else 0,
        "event_count": len(midi_events) if midi_events else 0,
        "canonical_smiles": Chem.MolToSmiles(mol),
        "bpm": bpm,
        "auto_play": auto_play,
        "session_id": session_id,
    }, 200


@app.route("/api/molecule_submit", methods=["POST"])
def api_molecule_submit():
    """
    接收 SMILES，使用 /home/user/文档/beifen/pinao8/分子到音乐 逻辑生成 MIDI。
    生成的 MIDI 存入队列，供前端轮询后自动演奏。
    可与 SMILES 同传 events/midi_events（联调参考），演奏仍仅用「分子到音乐」由 SMILES 计算的结果。
    支持 auto_play 参数：若 auto_play=1，前端收到后立即演奏，演奏后自动清除。
    """
    data = request.get_json(silent=True) or {}
    body, status = _enqueue_molecule_music_from_request(data, "molecule_submit")
    return jsonify(body), status


@app.route("/api/molecule_queue_state", methods=["GET"])
def api_molecule_queue_state():
    with _MOLECULE_SUBMIT_LOCK:
        return jsonify({"seq": _molecule_queue.get("seq", 0)})


@app.route("/api/molecule_music_ui_pending", methods=["GET"])
def api_molecule_music_ui_pending():
    """大屏轮询：是否有待确认的分子音乐（SMILES→MIDI）。
    
    自动演奏模式（auto_play=1）：
    - 前端收到数据后立即演奏
    - 演奏后前端调用 /api/molecule_music_ui_dismiss 清除
    - 或超时后自动清除
    """
    global _mol_music_ui_pending
    
    with _MOL_MUSIC_UI_LOCK:
        p = _mol_music_ui_pending
        
        # 清理过期的自动演奏状态
        now = time.time()
        stale_sessions = [
            sid for sid, st in _MOL_MUSIC_AUTOPLAY_STATE.items()
            if now - st.get("started_at", now) > _MOL_MUSIC_AUTOPLAY_TIMEOUT
        ]
        for sid in stale_sessions:
            _MOL_MUSIC_AUTOPLAY_STATE.pop(sid, None)
        
        # 如果当前 pending 是自动演奏模式且已超时，自动清除
        if p and p.get("auto_play") and p.get("session_id"):
            sid = p.get("session_id")
            if sid in _MOL_MUSIC_AUTOPLAY_STATE:
                st = _MOL_MUSIC_AUTOPLAY_STATE[sid]
                if now - st.get("started_at", now) > _MOL_MUSIC_AUTOPLAY_TIMEOUT:
                    _mol_music_ui_pending = None
                    _MOL_MUSIC_AUTOPLAY_STATE.pop(sid, None)
                    p = None
            else:
                # 状态丢失，也清除
                _mol_music_ui_pending = None
                p = None
    
    if not p:
        return jsonify({"pending": False})
    
    return jsonify({
        "pending": True,
        "seq": p.get("seq"),
        "smiles": p.get("smiles"),
        "canonical_smiles": p.get("canonical_smiles"),
        "bpm": p.get("bpm"),
        "midi_events": p.get("midi_events") or [],
        "session_id": p.get("session_id") or str(p.get("seq", "")),
        "auto_play": p.get("auto_play", False),
        "submitted_at": p.get("submitted_at"),
    })


@app.route("/api/molecule_music_ui_dismiss", methods=["POST"])
def api_molecule_music_ui_dismiss():
    """前端演奏完成后调用，清除 pending 状态。"""
    global _mol_music_ui_pending
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id") or ""
    
    with _MOL_MUSIC_UI_LOCK:
        # 如果是自动演奏模式，更新状态为 finished
        if session_id and session_id in _MOL_MUSIC_AUTOPLAY_STATE:
            _MOL_MUSIC_AUTOPLAY_STATE[session_id]["status"] = "finished"
            _MOL_MUSIC_AUTOPLAY_STATE[session_id]["finished_at"] = time.time()
        
        # 清除 pending
        _mol_music_ui_pending = None
    
    return jsonify({"ok": True, "session_id": session_id})


# ============ MIDI 交换：接口推送 → 前端大屏确认演奏 ============

_ext_midi_lock = threading.Lock()
_ext_midi_pending = None


def _normalize_midi_exchange_events(events):
    out = []
    if not isinstance(events, list):
        return out
    for e in events:
        if not isinstance(e, dict):
            continue
        note = e.get("note", e.get("midi"))
        if note is None:
            continue
        try:
            note = int(note)
        except Exception:
            continue
        if note < 0 or note > 127:
            continue
        if "start" in e or "duration" in e:
            try:
                start = max(0, int(e.get("start", 0)))
                duration = max(40, int(e.get("duration", 200)))
            except Exception:
                continue
            out.append({"note": note, "start": start, "duration": duration})
        elif "startMs" in e and "endMs" in e:
            try:
                t0 = int(e["startMs"])
                t1 = int(e["endMs"])
            except Exception:
                continue
            dur = max(40, t1 - t0)
            out.append({"note": note, "start": max(0, t0), "duration": dur})
    return out


@app.route("/api/midi_exchange", methods=["POST"])
def api_midi_exchange():
    data = request.get_json(silent=True) or {}
    # 若携带 SMILES（可与 MIDI events 同包），一律走「分子到音乐」由 SMILES 计算 MIDI，不直接用请求里的 events 入队
    smiles_in = (data.get("smiles") or "").strip()
    if smiles_in:
        body, status = _enqueue_molecule_music_from_request(data, "midi_exchange")
        return jsonify(body), status

    events = _normalize_midi_exchange_events(data.get("events") or [])
    if not events:
        return jsonify({"ok": False, "error": "events 无效或为空"}), 400
    try:
        bpm = int(data.get("bpm", 100))
    except Exception:
        bpm = 100
    bpm = max(40, min(240, bpm))
    label = str(data.get("source") or data.get("label") or "external")
    global _ext_midi_pending
    with _ext_midi_lock:
        _ext_midi_pending = {"events": events, "bpm": bpm, "label": label}
    return jsonify({"ok": True})


@app.route("/api/midi_exchange/ui_pending", methods=["GET"])
def api_midi_exchange_ui_pending():
    with _ext_midi_lock:
        p = _ext_midi_pending
    if not p:
        return jsonify({"pending": False})
    return jsonify({"pending": True, "events": p["events"], "bpm": p["bpm"], "label": p["label"]})


@app.route("/api/midi_exchange/ui_dismiss", methods=["POST"])
def api_midi_exchange_ui_dismiss():
    global _ext_midi_pending
    with _ext_midi_lock:
        _ext_midi_pending = None
    return jsonify({"ok": True})


@app.route("/api/music_to_molecule_midi", methods=["POST"])
def api_music_to_molecule_midi():
    """
    表单字段除 midi、bpm 外，可选 push_outbound_smiles=1|true（与 JSON 版语义一致）；
    仅在为真时推理成功后 POST __push/smiles。
    """
    f = request.files.get("midi")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "缺少表单字段 midi（文件）"}), 400
    tmp = tempfile.NamedTemporaryFile(suffix=".mid", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        f.save(str(tmp_path))
        try:
            bpm_val = int(request.form.get("bpm", 100))
        except (TypeError, ValueError):
            bpm_val = 100
        bpm_val = max(40, min(240, bpm_val))
        try:
            midi_event_count = len(_midi_file_to_events(str(tmp_path)))
        except Exception:
            midi_event_count = 0
        t0 = time.time()
        result = _run_transformer_from_midi_path(tmp_path, "browser_upload")
        infer_ms = int((time.time() - t0) * 1000)
        log.info(
            "music_to_molecule_midi ok: inference_ms=%s",
            infer_ms,
        )
        return jsonify(_music_to_molecule_response_dict(result, infer_ms, midi_event_count, bpm_val)), 200
    except Exception as exc:
        if _music_to_mol_exc_should_demo_fallback(exc):
            try:
                try:
                    bpm_val = int(request.form.get("bpm", 100))
                except (TypeError, ValueError):
                    bpm_val = 100
                bpm_val = max(40, min(240, bpm_val))
                evs = _midi_file_to_events(str(tmp_path))
                seq = _events_list_to_note_sequence(evs)
                t1 = time.time()
                result = _fallback_music_to_smiles_result_from_notes(seq)
                infer_ms = int((time.time() - t1) * 1000)
                log.warning("music_to_molecule_midi 接口兜底演示 SMILES（此前异常：%s）", exc)
                return jsonify(_music_to_molecule_response_dict(result, infer_ms, len(evs), bpm_val)), 200
            except Exception as exc2:
                exc = exc2
        log.error("music_to_molecule_midi failed: %s\n%s", exc, traceback.format_exc())
        return jsonify({"ok": False, "error": str(exc)}), 500
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


@app.route("/api/children_midi_manifest", methods=["GET"])
def api_children_midi_manifest():
    import re
    items = []
    p = _MUSIC_TO_MOLECULE_ROOT / "children_midi.jsonl"
    if p.exists():
        with p.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                mid = rec.get("midi_path") or ""
                base = Path(mid).name
                stem = base[:-4] if base.endswith(".mid") else base
                sk = re.sub(r"^\d+_", "", stem)
                items.append({
                    "id": rec.get("id") or stem,
                    "file_hint": base,
                    "song_key": sk,
                })
    return jsonify({"ok": True, "items": items})
@app.route("/api/play_example_midi", methods=["POST"])
def api_play_example_midi():
    """
    接收 MIDI 文件名或 song_key，解析对应 MIDI 文件并放入播放队列。
    前端轮询 /api/midi_exchange/ui_pending 后自动演奏。

    请求 JSON:
      { "filename": "03_生日快乐_Happy_Birthday.mid" }
      或
      { "song_key": "生日快乐_Happy_Birthday" }
      可选: { "bpm": 100, "auto_play": true }

    响应 JSON:
      { "ok": true, "event_count": 25, "bpm": 100,
        "filename": "03_生日快乐_Happy_Birthday.mid",
        "song_key": "生日快乐_Happy_Birthday",
        "total_duration_ms": 13636 }
    """
    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename") or "").strip()
    song_key = str(data.get("song_key") or "").strip()
    query = filename or song_key

    if not query:
        return jsonify({"ok": False, "error": "缺少参数：请提供 filename 或 song_key"}), 400

    midi_path = _find_example_midi_file(query)
    if not midi_path:
        return jsonify({"ok": False, "error": f"未找到 MIDI 文件: {query}"}), 404

    try:
        events = _midi_file_to_events(str(midi_path))
    except Exception as exc:
        log.error("解析 MIDI 文件失败: %s\n%s", exc, traceback.format_exc())
        return jsonify({"ok": False, "error": f"MIDI 解析失败: {exc}"}), 500

    if not events:
        return jsonify({"ok": False, "error": "MIDI 文件中没有有效的音符事件"}), 400

    try:
        bpm = int(data.get("bpm", 100))
    except (TypeError, ValueError):
        bpm = 100
    bpm = max(40, min(240, bpm))

    # 复用 midi_exchange 机制：将事件存入队列，前端轮询后自动播放
    label = str(data.get("source") or data.get("label") or f"example_midi:{midi_path.name}")
    global _ext_midi_pending
    with _ext_midi_lock:
        _ext_midi_pending = {"events": events, "bpm": bpm, "label": label}

    total_duration = events[-1]["start"] + events[-1]["duration"] if events else 0

    # 同时发送到 8082 大屏（如果外发启用）
    if _outbound_relay_enabled():
        glass_events = [
            {"note": e["note"], "start": e["start"], "duration": e["duration"]}
            for e in events
        ]
        ok_relay, err_relay = _relay_midi_to_glass_session(glass_events, bpm)
        if not ok_relay:
            log.warning("play_example_midi 发送到 8082 失败: %s", err_relay)

    log.info("play_example_midi: queued %s, events=%s, bpm=%s", midi_path.name, len(events), bpm)

    return jsonify({
        "ok": True,
        "event_count": len(events),
        "bpm": bpm,
        "filename": midi_path.name,
        "song_key": song_key or _find_song_key_from_filename(midi_path.name),
        "total_duration_ms": total_duration,
    })


def _find_song_key_from_filename(filename):
    """从 MIDI 文件名提取 song_key（去掉序号前缀和 .mid 后缀）。"""
    import re
    stem = filename[:-4] if filename.endswith(".mid") else filename
    return re.sub(r"^\d+_", "", stem)



@app.route("/api/outbound/realtime_midi", methods=["POST"])
def api_outbound_realtime_midi():
    """
    浏览器每键上报；note_on 仅入栈，note_off 时组一条 {start,duration,note} 毫秒事件 POST 到 {BASE}/__push/midi。
    请求 JSON: { "type": "note_on"|"note_off", "note": int, "timestamp_ms"?: int, "bpm"?: int }
    """
    data = request.get_json(silent=True) or {}
    t = str(data.get("type") or data.get("event") or "").strip().lower()
    if t not in ("note_on", "note_off"):
        return jsonify({"ok": False, "error": "type 需为 note_on 或 note_off"}), 400
    try:
        note = int(data.get("note", data.get("midi")))
    except Exception:
        return jsonify({"ok": False, "error": "note 无效"}), 400
    if note < 0 or note > 127:
        return jsonify({"ok": False, "error": "note 超出 0..127"}), 400
    try:
        ts = int(data.get("timestamp_ms", int(time.time() * 1000)))
    except Exception:
        ts = int(time.time() * 1000)
    try:
        bpm = int(data.get("bpm", 100))
    except Exception:
        bpm = 100
    bpm = max(40, min(240, bpm))

    if not _outbound_relay_enabled():
        return jsonify({"ok": True, "relayed": False, "reason": "MUSICMOL_OUTBOUND_ENABLE=0"})
    if not _outbound_midi_push_url():
        return jsonify({"ok": True, "relayed": False, "reason": "MUSICMOL_OUTBOUND_MIDI_PUSH_URL empty"})

    events = None
    had_matching_note_on = False
    with _RT_PUSH_LOCK:
        if t == "note_on":
            _RT_NOTE_ON_STACK.setdefault(note, []).append(ts)
            with _OUTBOUND_MON_LOCK:
                _outbound_mon["realtime_midi"]["await_note_off"] += 1
            return jsonify({"ok": True, "relayed": False, "reason": "await_note_off"})
        stack = _RT_NOTE_ON_STACK.get(note)
        if stack:
            had_matching_note_on = True
            t0 = stack.pop()
            if not stack:
                del _RT_NOTE_ON_STACK[note]
            dur = max(1, ts - t0)
            events = [{"note": note, "start": t0, "duration": dur}]
        else:
            events = [{"note": note, "start": max(0, ts - 40), "duration": 40}]
            with _OUTBOUND_MON_LOCK:
                _outbound_mon["realtime_midi"]["orphan_note_off"] += 1

    # 实时弹奏走 __push/midi（仅 events），勿用 smiles:"pending" 的 glass_session 整包，
    # 否则嵌入页会误锁 SMILES 轨道并跳过此后所有 MIDI 脉冲。
    ok, err = _relay_midi_events_to_push(events, bpm)
    if not ok:
        with _OUTBOUND_MON_LOCK:
            _outbound_mon["realtime_midi"]["relayed_err"] += 1
            _outbound_mon["last"]["realtime_midi"] = {
                "t": time.time(),
                "ok": False,
                "error": err,
                "event_count": len(events),
                "matched_note_on": had_matching_note_on,
            }
        log.warning("outbound __push/glass_session (midi) failed: %s", err)
        return jsonify({"ok": True, "relayed": False, "forward_error": err, "count": len(events)})
    with _OUTBOUND_MON_LOCK:
        _outbound_mon["realtime_midi"]["relayed_ok"] += 1
        _outbound_mon["last"]["realtime_midi"] = {
            "t": time.time(),
            "ok": True,
            "event_count": len(events),
            "matched_note_on": had_matching_note_on,
        }
    return jsonify({"ok": True, "relayed": True, "count": len(events)})


@app.route("/api/outbound/smiles", methods=["POST"])
def api_outbound_smiles():
    """
    显式触发 SMILES 外发（与推理后自动推送相同：POST {BASE}/__push/smiles）。
    请求 JSON: { "best_smiles" 或 "smiles", "编号"?: ... }
    """
    data = request.get_json(silent=True) or {}
    smiles = (data.get("best_smiles") or data.get("smiles") or data.get("SMILES") or "").strip()
    if not smiles:
        return jsonify({"ok": False, "error": "best_smiles 为空"}), 400
    if not _outbound_relay_enabled():
        return jsonify({"ok": True, "relayed": False, "reason": "MUSICMOL_OUTBOUND_ENABLE=0"})
    url = _outbound_smiles_push_url()
    if not url:
        return jsonify({"ok": True, "relayed": False, "reason": "MUSICMOL_OUTBOUND_SMILES_URL empty"})
    pl = {"smiles": smiles}
    bid = data.get("编号") or data.get("molecule_id") or data.get("moleculeId") or data.get("药物编号")
    if bid is not None and str(bid).strip() != "":
        pl["编号"] = bid
    ok, err = _http_post_json(url, pl, timeout_sec=5.0)
    if not ok:
        _record_outbound_event("smiles_push", False, {"source": "api_outbound_smiles", "error": err, "url": url})
        return jsonify({"ok": False, "error": "relay_failed", "detail": err}), 502
    _record_outbound_event("smiles_push", True, {"source": "api_outbound_smiles", "url": url})
    return jsonify({"ok": True, "relayed": True})


# ============ 管理监控 API 与 /admin 控制台 ============


def _readiness_dict():
    ckpt_ok = any(
        p.exists()
        for p in (
            _MUSIC_TO_MOLECULE_ROOT / "model_last(2).pt",
            _MUSIC_TO_MOLECULE_ROOT / "model_last.pt",
            _WORKSPACE_ROOT / "model_last(2).pt",
            _WORKSPACE_ROOT / "model_last.pt",
        )
    )
    cfg_ok = any(
        p.exists()
        for p in (_MUSIC_TO_MOLECULE_ROOT / "config.json", _WORKSPACE_ROOT / "config.json")
    )
    music_to_molecule_ready = bool(_MUSIC_TO_MOLECULE_ROOT.exists() and ckpt_ok and cfg_ok)
    molecule_to_music_ready = bool(_MOLECULE_TO_MUSIC_ROOT.exists())
    return {
        "music_to_molecule": music_to_molecule_ready,
        "molecule_to_music": molecule_to_music_ready,
    }


@app.route("/api/admin/snapshot", methods=["GET"])
def api_admin_snapshot():
    """聚合：就绪状态、队列、待办、内存统计、活动日志、趋势序列（需 X-Admin-Token）。"""
    if not _admin_token_ok():
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    with _MOLECULE_SUBMIT_LOCK:
        qseq = int(_molecule_queue.get("seq", 0))
        qlast = _molecule_queue.get("last")

    with _MOL_MUSIC_UI_LOCK:
        mp = _mol_music_ui_pending
    if mp:
        evs = mp.get("midi_events") or []
        pend_mol = {
            "pending": True,
            "seq": mp.get("seq"),
            "bpm": mp.get("bpm"),
            "canonical_smiles_preview": (mp.get("canonical_smiles") or "")[:96],
            "midi_event_count": len(evs),
        }
    else:
        pend_mol = {"pending": False}

    with _ext_midi_lock:
        ep = _ext_midi_pending
    if ep:
        ev = ep.get("events") or []
        pend_ext = {
            "pending": True,
            "label": ep.get("label"),
            "bpm": ep.get("bpm"),
            "event_count": len(ev),
        }
    else:
        pend_ext = {"pending": False}

    paths = {
        "workspace_root": str(_WORKSPACE_ROOT),
        "MusicMol_0322": str(_ROOT),
        "music_to_molecule_dir": str(_MUSIC_TO_MOLECULE_ROOT),
        "music_to_molecule_dir_exists": _MUSIC_TO_MOLECULE_ROOT.exists(),
        "molecule_to_music_dir": str(_MOLECULE_TO_MUSIC_ROOT),
        "molecule_to_music_dir_exists": _MOLECULE_TO_MUSIC_ROOT.exists(),
        "model_ckpt_music_to_mol": str(
            next(
                (p for p in (_MUSIC_TO_MOLECULE_ROOT / "model_last(2).pt", _MUSIC_TO_MOLECULE_ROOT / "model_last.pt", _WORKSPACE_ROOT / "model_last(2).pt", _WORKSPACE_ROOT / "model_last.pt") if p.exists()),
                _MUSIC_TO_MOLECULE_ROOT / "model_last.pt",
            )
        ),
        "model_ckpt_exists": any(
            p.exists()
            for p in (
                _MUSIC_TO_MOLECULE_ROOT / "model_last(2).pt",
                _MUSIC_TO_MOLECULE_ROOT / "model_last.pt",
                _WORKSPACE_ROOT / "model_last(2).pt",
                _WORKSPACE_ROOT / "model_last.pt",
            )
        ),
        "config_json_exists": any(
            p.exists() for p in (_MUSIC_TO_MOLECULE_ROOT / "config.json", _WORKSPACE_ROOT / "config.json")
        ),
    }

    runtime = {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "torch_available": _TORCH_AVAILABLE,
        "torch_version": torch.__version__ if _TORCH_AVAILABLE else None,
        "pid": os.getpid(),
        "cwd": os.getcwd(),
    }

    with _METRICS_LOCK:
        counts = dict(_metrics["counts"])
        activity = list(_metrics["activity"])
        _series.append({"t": time.time(), "counts": dict(counts)})
        series = list(_series)

    with _PIANO_MODE_LOCK:
        piano_mode = _PIANO_INTERACTION_MODE
    with _RT_PUSH_LOCK:
        rt_note_stack_size = sum(len(v) for v in _RT_NOTE_ON_STACK.values())
        rt_note_stack_notes = len(_RT_NOTE_ON_STACK)
    with _OUTBOUND_MON_LOCK:
        outbound_mon = json.loads(json.dumps(_outbound_mon))

    internal_interfaces = {
        "piano_interaction_mode": {"path": "/api/piano_interaction_mode", "method": "GET", "polling": True},
        "molecule_music_ui_pending": {"path": "/api/molecule_music_ui_pending", "method": "GET", "polling": True},
        "midi_exchange_ui_pending": {"path": "/api/midi_exchange/ui_pending", "method": "GET", "polling": True},
        "outbound_realtime_midi": {"path": "/api/outbound/realtime_midi", "method": "POST", "polling": False},
        "music_to_molecule": {"path": "/api/music_to_molecule", "method": "POST", "polling": False},
        "music_to_molecule_midi": {"path": "/api/music_to_molecule_midi", "method": "POST", "polling": False},
        "molecule_to_music": {"path": "/api/molecule_to_music", "method": "POST", "polling": False},
        "molecule_submit": {"path": "/api/molecule_submit", "method": "POST", "polling": False},
        "midi_exchange": {"path": "/api/midi_exchange", "method": "POST", "polling": False},
        "play_example_midi": {"path": "/api/play_example_midi", "method": "POST", "polling": False},
    }
    external_interfaces = {
        "outbound_enabled": _outbound_relay_enabled(),
        "base": _outbound_base(),
        "midi_push_url": _outbound_midi_push_url(),
        "smiles_push_url": _outbound_smiles_push_url(),
        "token_enabled": bool(_outbound_auth_headers()),
    }
    workflow = {
        "step_1_intake": {
            "piano_mode": piano_mode,
            "pending_external_midi": bool(pend_ext.get("pending")),
            "pending_molecule_music": bool(pend_mol.get("pending")),
        },
        "step_2_queue_and_state": {
            "molecule_queue_seq": qseq,
            "molecule_last_exists": bool(qlast),
            "ext_midi_pending_event_count": (pend_ext.get("event_count") or 0) if pend_ext.get("pending") else 0,
        },
        "step_3_transform": {
            "music_to_molecule_ready": _readiness_dict().get("music_to_molecule"),
            "molecule_to_music_ready": _readiness_dict().get("molecule_to_music"),
            "counts": {
                "music_to_molecule_ok": counts.get("music_to_molecule_ok", 0),
                "music_to_molecule_err": counts.get("music_to_molecule_err", 0),
                "music_to_molecule_midi_ok": counts.get("music_to_molecule_midi_ok", 0),
                "music_to_molecule_midi_err": counts.get("music_to_molecule_midi_err", 0),
                "molecule_to_music_ok": counts.get("molecule_to_music_ok", 0),
                "molecule_to_music_err": counts.get("molecule_to_music_err", 0),
            },
        },
        "step_4_outbound": {
            "realtime_note_stack_notes": rt_note_stack_notes,
            "realtime_note_stack_size": rt_note_stack_size,
            "stats": outbound_mon,
        },
    }

    return jsonify(
        {
            "ok": True,
            "uptime_sec": time.time() - _metrics["started_at"],
            "piano_interaction_mode": piano_mode,
            "readiness": _readiness_dict(),
            "molecule_queue": {"seq": qseq, "last": qlast},
            "pending": {"molecule_music_ui": pend_mol, "midi_exchange": pend_ext},
            "paths": paths,
            "runtime": runtime,
            "counts": counts,
            "activity": activity,
            "series": series,
            "workflow": workflow,
            "interfaces": {"internal": internal_interfaces, "external": external_interfaces},
        }
    )


@app.route("/admin")
def admin_console_redirect():
    return redirect("/admin/", code=302)


@app.route("/admin/")
def admin_console_index():
    if not _ADMIN_DIR.is_dir():
        return jsonify({"ok": False, "error": "admin directory missing"}), 500
    return send_from_directory(_ADMIN_DIR, "index.html")


_ADMIN_ASSET_ALLOW = frozenset({"admin-dashboard.css", "admin-dashboard.js"})


@app.route("/admin/<path:subpath>")
def admin_console_asset(subpath):
    if subpath not in _ADMIN_ASSET_ALLOW:
        return jsonify({"ok": False, "error": "not found"}), 404
    return send_from_directory(_ADMIN_DIR, subpath)


# ============ 静态文件服务 ============

@app.route("/favicon.ico")
def _favicon_noop():
    """避免控制台对默认 favicon 请求的 404 噪音。"""
    return Response(status=204)


@app.route("/")
def _serve_index():
    return send_from_directory(_ROOT, "index.html")


@app.route("/index.html")
def _serve_index_explicit():
    return send_from_directory(_ROOT, "index.html")


_ROOT_ASSETS = (
    "style.css",
    "note-config.js",
    "smile_to_score_v4.js",
    "score_to_smile.js",
    "piano3d-941.js",
    "piano.js",
    "api-molecule-play.js",
    "staff-render.js",
    "local_vendor_info.json",
    "musicmol-piano.css",
    "musicmol-piano.js",
    "demo-songs-data.js",
    "demo-songs-glass-meta.js",
    "sound-activity-logger.js",
)

# Soundfont 静态文件路由（vendor 目录下的深层文件）
@app.route("/vendor/soundfont/<path:subpath>")
def _serve_vendor_soundfont(subpath):
    return send_from_directory(_ROOT / "vendor" / "soundfont", subpath)


def _register_root_assets():
    for _fname in _ROOT_ASSETS:
        def _make_view(filename):
            def _view():
                return send_from_directory(_ROOT, filename)
            _view.__name__ = "root_asset_" + filename.replace(".", "_")
            return _view
        app.add_url_rule("/" + _fname, "root_asset_" + _fname.replace(".", "_"), _make_view(_fname), methods=["GET"])


_register_root_assets()


def _warmup_transformer():
    """预热：启动时跑一次短推理，加载权重（设备见 MUSICMOL_INFERENCE_DEVICE / 自动 cpu）。"""
    if (os.environ.get("MUSICMOL_WARMUP_DISABLE") or "").strip() == "1":
        print("[MusicMol] MUSICMOL_WARMUP_DISABLE=1：跳过启动预热。")
        return
    if not _TORCH_AVAILABLE:
        print(
            "[MusicMol] 未检测到 PyTorch：音乐→分子接口将返回演示用 SMILES（按音符哈希映射）。"
            "安装 torch 与模型权重后可使用真实 Transformer 推理。"
        )
        return
    try:
        dev = _music_mol_inference_device()
        print(f"[MusicMol] 正在预热 Transformer（device={dev}，首次约需数秒）…")
        _run_transformer_music_to_smiles(
            [{"note": 60, "start": 0, "duration": 400}],
            100,
        )
        print("[MusicMol] 预热完成，模型已就绪。")
    except Exception as exc:
        print("[MusicMol] 预热失败（首次请求时仍会尝试加载）:", exc)


def _first_non_loopback_ipv4():
    try:
        out = subprocess.run(
            ["hostname", "-I"],
            capture_output=True,
            text=True,
            timeout=1.0,
            check=False,
        ).stdout or ""
        for tok in out.split():
            if tok.startswith("127."):
                continue
            if "." in tok:
                return tok
    except Exception:
        pass
    return None


def _maybe_init_unified():
    v = str(os.environ.get("MUSICMOL_UNIFIED", "") or "").strip().lower()
    if v not in ("1", "true", "yes"):
        return
    os.environ.setdefault(
        "MUSICMOL_LISTEN_PORT",
        str(os.environ.get("MUSICMOL_UNIFIED_PORT") or DEFAULT_UNIFIED_PORT).strip() or DEFAULT_UNIFIED_PORT,
    )
    try:
        from unified_runtime import init_unified

        init_unified(app)
    except Exception as exc:
        log.warning("MUSICMOL_UNIFIED init failed: %s", exc)


_maybe_init_unified()


# ============ 服务器资源监控 ============

@app.route("/api/system_stats", methods=["GET"])
def api_system_stats():
    import psutil
    import time
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_count = psutil.cpu_count(logical=False) or 1
    cpu_count_logical = psutil.cpu_count(logical=True) or cpu_count
    cpu_freq = psutil.cpu_freq()
    cpu_load = [round(x, 2) for x in psutil.getloadavg()] if hasattr(psutil, "getloadavg") else [0, 0, 0]
    # Memory
    vm = psutil.virtual_memory()
    # Disk
    du = psutil.disk_usage("/")
    # Network
    net_io = psutil.net_io_counters()
    net_if = psutil.net_if_addrs()
    interfaces = [{"name": k} for k in list(net_if.keys())[:3]]
    # GPU (try nvidia-ml)
    gpu = {"available": False}
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode("utf-8")
        gpu = {
            "available": True,
            "name": name,
            "utilization": util.gpu,
            "memory_used": round(mem.used / 1024 / 1024),
            "memory_total": round(mem.total / 1024 / 1024),
            "temperature": temp,
        }
    except Exception:
        pass
    # Top processes by CPU
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_info", "cpu_percent"]):
        try:
            info = p.info
            procs.append({
                "name": info["name"] or "?",
                "memory_mb": info["memory_info"].rss / 1024 / 1024,
                "cpu_percent": info["cpu_percent"] or 0.0,
            })
        except Exception:
            pass
    procs.sort(key=lambda x: x["cpu_percent"], reverse=True)
    return jsonify({
        "cpu": {
            "percent": round(cpu_percent, 1),
            "cores": cpu_count,
            "logical": cpu_count_logical,
            "freq": round(cpu_freq.current) if cpu_freq else 0,
            "load": cpu_load,
        },
        "memory": {
            "percent": vm.percent,
            "used": vm.used,
            "total": vm.total,
            "available": vm.available,
            "cached": getattr(vm, "cached", 0),
            "buffers": getattr(vm, "buffers", 0),
        },
        "disk": {
            "percent": round(du.percent, 1),
            "used": du.used,
            "total": du.total,
            "free": du.free,
            "mountpoint": "/",
        },
        "net": {
            "interfaces": interfaces,
            "total_sent": net_io.bytes_sent,
            "total_recv": net_io.bytes_recv,
            "timestamp": int(time.time() * 1000),
        },
        "gpu": gpu,
        "processes": procs[:5],
    })


@app.route("/monitor")
def serve_monitor():
    return send_from_directory(str(_ROOT), "monitor.html")


if __name__ == "__main__":
    print(f"[MusicMol] Python 解释器: {sys.executable}")
    _warmup_transformer()
    try:
        listen_port = int((os.environ.get("MUSICMOL_LISTEN_PORT") or DEFAULT_API_PORT).strip())
    except ValueError:
        listen_port = 5020
    raw_host = (os.environ.get("MUSICMOL_LISTEN_HOST") or "").strip()
    bind_remote = (os.environ.get("MUSICMOL_BIND_REMOTE") or "0").strip() == "1"
    if raw_host:
        listen_host = raw_host
    else:
        listen_host = "0.0.0.0" if bind_remote else "127.0.0.1"
    lan_ip = _first_non_loopback_ipv4()
    lan_line = (
        f"\n  局域网/端口映射端: http://{lan_ip}:{listen_port}/"
        if lan_ip and listen_host in ("0.0.0.0", "::", "[::]")
        else ""
    )
    mode_str = (
        "全部网卡(0.0.0.0 等)，局域网与端口映射可同时访问"
        if listen_host == "0.0.0.0"
        else f"绑定 {listen_host}"
    )
    print(
        f"MusicMol: 监听 {listen_host}:{listen_port}（{mode_str}）\n"
        f"  本机访问: http://127.0.0.1:{listen_port}/"
        f"{lan_line}\n"
        f"  外发数据默认 POST 到: {_outbound_base()}（实时 MIDI / 推理 SMILES）\n"
        f"  若页面由 8081 上的外部程序托管，前端会将 API 指向本项目 :{listen_port}\n"
        f"  映射 API 日志: {_ROOT / 'logs'}/mapping_api.log 与 mapping_poll_state.log"
        f"（轮询间隔 MUSICMOL_MAPPING_POLL_SEC，设 MUSICMOL_MAPPING_POLL_DISABLE=1 可关）"
    )
    # threaded=True：避免单次 Transformer 推理占用 worker 时，轮询 / status_lite / 其它会话全部被阻塞
    app.run(
        debug=True,
        host=listen_host,
        port=listen_port,
        use_reloader=False,
        threaded=True,
    )
