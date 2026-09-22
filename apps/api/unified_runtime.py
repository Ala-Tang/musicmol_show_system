"""
MusicMol 合一部署：单进程单对外端口（默认 MUSICMOL_LISTEN_PORT / 9080）。

- PainoJS 静态资源在 /app/；默认 `/app/`、`/app/index.html` 会 **302 → `/app/unified-single.html`**（单页：展陈 + 钢琴同 document）。仅展陈：`/app/index.html?standalone=1`。顶 iframe（旧双 iframe 壳）：`/app/index.html?unifiedShell=1` + `/app/unified.html`。钢琴资源：`/app/mm-piano/*` 与 `/app/piano-embed/*` 均指向 MusicMol_0322 根目录（mm-piano 不对 .html 做注入，供单页引用 JS/CSS）。
- 原 8082 UI 轮询在进程内 127.0.0.1:随机端口 由 http.server 提供；Flask 将 /paino-stream/* 反向代理到该端口
- 原 8767 RDKit FastAPI 在进程内 127.0.0.1:随机端口 由 uvicorn 提供；Flask 将 /rdkit-proxy/* 反向代理到该端口
- 浏览器侧：在展陈 HTML 头注入 `MUSICMOL_OUTBOUND_BASE = origin + '/paino-stream'`，与 piano-embed 一致，供 `musicmol-piano.js` 的 `POST …/__push/*` 走代理（mm-piano 静态 JS 无单独 HTML 注入）。
- 进程侧：`_ensure_embedded_ui_poll` 将 `os.environ["MUSICMOL_OUTBOUND_BASE"]` 设为内嵌 ui_poll 的 `http://127.0.0.1:<随机端口>`，供 Flask `app.py` 后端向同一进程内的接收端 POST `__push/*`（与浏览器经公网路径 `/paino-stream` 代理到同一队列）。
- 浏览器仅访问本 Flask 端口；通过注入 globalThis + stack-bootstrap 早退，避免再写 5020/8766/8082/8767

环境变量：MUSICMOL_UNIFIED=1 时由 app.py 调用 init_unified(app)。
MUSICMOL_RDKIT_READY_TIMEOUT_SEC：等待内嵌 RDKit（uvicorn）/health 就绪的最长时间（秒），默认 45。
"""
from __future__ import annotations

import importlib.util
import os
import sys
import threading
import time
from http.client import HTTPConnection
from pathlib import Path

from flask import Response, redirect, request, send_from_directory

from runtime_config import DEFAULT_UNIFIED_PORT

# 直接打开 /app/index.html 时重定向到单页合一；?unifiedShell=1 为旧壳顶 iframe；?standalone=1 为仅展陈调试
_UNIFIED_PAINO_INDEX_REDIRECT = 302

_POLL_HTTPD = None
_POLL_PORT: int | None = None
_POLL_LOCK = threading.Lock()
_RDKIT_PORT: int | None = None
_RDKIT_LOCK = threading.Lock()
_RDKIT_DISABLED = False
_MUSICMOL_ROOT = Path(__file__).resolve().parent
_PC_ROOT = _MUSICMOL_ROOT.parent.parent
_PAINOJS_ROOT = _PC_ROOT / "apps" / "web"
# 顶层共享前端包（/app/packages/*）：无打包前端经 import map @mm/* 引用，dev 模式经 apps/web/packages symlink
_PACKAGES_ROOT = _PC_ROOT / "packages"
# 独立 iframe 钢琴页（/app/piano-embed/*）：MusicMol_0322 根目录 index.html
_PIANO_EMBED_ROOT = _MUSICMOL_ROOT.resolve()
# 单页合一引用的 /app/mm-piano/*：与 painojs/unified-single 同源，避免与 MusicMol_0322 副本样式漂移
_MM_PIANO_ROOT = (_PAINOJS_ROOT / "mm-piano").resolve()


def _load_ui_poll_handler():
    uip = _PC_ROOT / "services" / "ui-poll-receiver" / "app.py"
    spec = importlib.util.spec_from_file_location("musicmol_unified_ui_poll", uip)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load ui_poll from {uip}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        ext = int(os.environ.get("MUSICMOL_LISTEN_PORT", DEFAULT_UNIFIED_PORT).strip() or DEFAULT_UNIFIED_PORT)
    except ValueError:
        ext = int(DEFAULT_UNIFIED_PORT)
    mod.PORT = ext
    return mod


def _ensure_embedded_ui_poll() -> int:
    global _POLL_HTTPD, _POLL_PORT
    with _POLL_LOCK:
        if _POLL_PORT is not None:
            return _POLL_PORT
        from http.server import HTTPServer

        mod = _load_ui_poll_handler()
        Handler = mod.Handler
        httpd = HTTPServer(("127.0.0.1", 0), Handler)
        _POLL_PORT = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, name="musicmol-embedded-ui-poll", daemon=True)
        t.start()
        _POLL_HTTPD = httpd
        base = f"http://127.0.0.1:{_POLL_PORT}"
        os.environ["MUSICMOL_OUTBOUND_BASE"] = base
        print(f"[unified] embedded ui_poll -> {base} (Flask public path /paino-stream/*)")
        return _POLL_PORT


def _ensure_embedded_rdkit() -> int | None:
    """在同进程内启动 painojs server.rdkit_embed（uvicorn），返回回环端口；失败则返回 None。"""
    global _RDKIT_PORT, _RDKIT_DISABLED
    with _RDKIT_LOCK:
        if _RDKIT_DISABLED:
            return None
        if _RDKIT_PORT is not None:
            return _RDKIT_PORT
        try:
            import uvicorn  # noqa: F401
        except ImportError:
            _RDKIT_DISABLED = True
            print(
                "[unified] WARNING: 未安装 uvicorn，RDKit 嵌入未启动。"
                " 请执行: pip install 'uvicorn[standard]>=0.27'（已写入 MusicMol_0322/requirements.txt）"
            )
            return None

        import socket

        rdkit_root = str((_PC_ROOT / "services" / "rdkit-embed").resolve())
        if rdkit_root not in sys.path:
            sys.path.insert(0, rdkit_root)

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
        sock.close()

        def _runner() -> None:
            if rdkit_root not in sys.path:
                sys.path.insert(0, rdkit_root)
            import uvicorn

            # services/rdkit-embed 目录名含连字符，无法包式导入；按文件路径加载 app.py，
            # 其 from similar_drugs_fda import ... 回退分支依赖该目录已在 sys.path。
            _rk_spec = importlib.util.spec_from_file_location(
                "musicmol_embedded_rdkit_app", str(Path(rdkit_root) / "app.py")
            )
            _rk_mod = importlib.util.module_from_spec(_rk_spec)
            _rk_spec.loader.exec_module(_rk_mod)
            rdkit_fastapi_app = _rk_mod.app

            uvicorn.run(
                rdkit_fastapi_app,
                host="127.0.0.1",
                port=port,
                log_level="warning",
                access_log=False,
            )

        t = threading.Thread(target=_runner, name="musicmol-embedded-rdkit-uvicorn", daemon=True)
        t.start()
        try:
            timeout_sec = float(os.environ.get("MUSICMOL_RDKIT_READY_TIMEOUT_SEC", "45").strip() or "45")
        except ValueError:
            timeout_sec = 45.0
        deadline = time.monotonic() + max(5.0, timeout_sec)
        ok = False
        while time.monotonic() < deadline:
            try:
                c = HTTPConnection("127.0.0.1", port, timeout=3)
                c.request("GET", "/health")
                r = c.getresponse()
                body = r.read()
                c.close()
                if r.status == 200:
                    bl = body.lower()
                    if b"ok" in bl or b'"status"' in bl:
                        ok = True
                        break
            except OSError:
                pass
            time.sleep(0.1)
        if not ok:
            _RDKIT_DISABLED = True
            print(f"[unified] WARNING: RDKit 嵌入在 127.0.0.1:{port} 未在时限内就绪，已禁用 /rdkit-proxy")
            return None
        _RDKIT_PORT = port
        print(f"[unified] embedded rdkit_embed -> http://127.0.0.1:{port} (Flask public path /rdkit-proxy/*)")
        return _RDKIT_PORT


def _inject_unified_head(html: bytes) -> bytes:
    rdk = b"globalThis.RDKIT_EMBED_API_BASE=globalThis.MUSICMOL_API_BASE+'/rdkit-proxy';"
    if _RDKIT_DISABLED or _RDKIT_PORT is None:
        rdk = b"globalThis.RDKIT_EMBED_API_BASE='';"
    # 显式拼接，避免多段相邻 bytes 与「+ rdk」混写时被误改成元组导致注入残缺。
    inj = (
        b"<script>(function(){"
        b"try{"
        b"globalThis.MUSICMOL_UNIFIED_SERVER=true;"
        b"globalThis.MUSICMOL_API_BASE=String(location.origin||'').replace(/\\/+$/, '');"
        b"globalThis.MUSICMOL_UI_POLL_BASE=globalThis.MUSICMOL_API_BASE+'/paino-stream';"
        b"globalThis.MUSICMOL_OUTBOUND_BASE=globalThis.MUSICMOL_API_BASE+'/paino-stream';"
        + rdk
        + b"}catch(_e){}"
        + b"})();</script>\n"
    )
    low = html.lower()
    i = low.find(b"<head>")
    if i == -1:
        return inj + html
    j = i + len(b"<head>")
    return html[:j] + inj + html[j:]


def _inject_piano_embed_head(html: bytes) -> bytes:
    """合一底栏钢琴页：与 PainoJS 同源 API + /paino-stream 代理（替代浏览器直连 :5020/:8082）。"""
    inj = (
        b"<script>(function(){"
        b"try{"
        b"globalThis.MUSICMOL_UNIFIED_SERVER=true;"
        b"var o=String(location.origin||'').replace(/\\/+$/, '');"
        b"globalThis.MUSICMOL_API_BASE=o;"
        b"globalThis.MUSICMOL_UI_POLL_BASE=o+'/paino-stream';"
        b"globalThis.MUSICMOL_OUTBOUND_BASE=o+'/paino-stream';"
        b"}catch(_e){}"
        b"})();</script>\n"
    )
    low = html.lower()
    i = low.find(b"<head>")
    if i == -1:
        return inj + html
    j = i + len(b"<head>")
    return html[:j] + inj + html[j:]


def _serve_musicmol_root_subpath(subpath: str, *, inject_html: bool) -> Response:
    """从 MusicMol_0322 根目录提供静态文件；inject_html 仅用于独立钢琴 HTML（piano-embed）。"""
    if ".." in subpath or subpath.startswith(("/", "\\")):
        return Response("bad path", 400)
    root = _PIANO_EMBED_ROOT
    if not root.is_dir():
        return Response("piano embed root missing", 404)
    try:
        fp = (root / subpath).resolve()
        fp.relative_to(root)
    except ValueError:
        return Response("not found", 404)
    except OSError:
        return Response("not found", 404)
    if not fp.is_file():
        return Response("not found", 404)
    if subpath.endswith(".html") and inject_html:
        raw = fp.read_bytes()
        raw = _inject_piano_embed_head(raw)
        return Response(raw, mimetype="text/html; charset=utf-8")
    return send_from_directory(str(root), subpath)


def _proxy_loopback(port: int, subpath: str) -> Response:
    path = "/" + subpath.lstrip("/")
    qs = request.query_string.decode("utf-8") if request.query_string else ""
    if qs:
        path = f"{path}?{qs}"
    conn = HTTPConnection("127.0.0.1", port, timeout=300)
    body = request.get_data() if request.method in ("POST", "PUT", "PATCH") else None
    hdrs = {}
    ct = request.headers.get("Content-Type")
    if ct:
        hdrs["Content-Type"] = ct
    conn.request(request.method, path, body=body, headers=hdrs)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    out = Response(data, status=r.status)
    for k, v in r.getheaders():
        lk = k.lower()
        if lk in (
            "content-type",
            "content-length",
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
        ):
            out.headers[k] = v
    out.headers.setdefault("Access-Control-Allow-Origin", "*")
    return out


def _proxy_to_poll(subpath: str) -> Response:
    port = _ensure_embedded_ui_poll()
    return _proxy_loopback(port, subpath)


def _proxy_to_rdkit(subpath: str) -> Response:
    port = _ensure_embedded_rdkit()
    if port is None:
        return Response(
            b'{"error":"rdkit_embed_unavailable","hint":"pip install uvicorn[standard]>=0.27"}',
            status=503,
            mimetype="application/json; charset=utf-8",
        )
    return _proxy_loopback(port, subpath)


def init_unified(app) -> None:
    """在 Flask app 上注册合一模式路由（幂等：重复调用跳过）。"""
    if getattr(app, "_musicmol_unified_inited", False):
        return
    if not _PAINOJS_ROOT.is_dir():
        raise RuntimeError(f"painojs root not found: {_PAINOJS_ROOT}")

    _ensure_embedded_ui_poll()
    _ensure_embedded_rdkit()

    @app.route("/.painojs-stack-mode.json", methods=["GET"])
    def _painojs_stack_mode_json():
        """合一端口无独立 Paino 栈配置时避免 404；stackModeGate 在非 200 时亦放行。"""
        return Response(b"{}", status=200, mimetype="application/json; charset=utf-8")

    @app.route("/paino-stream/<path:subpath>", methods=["GET", "POST", "OPTIONS"])
    def _paino_stream_proxy(subpath: str):
        if request.method == "OPTIONS":
            return Response(
                status=204,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            )
        return _proxy_to_poll(subpath)

    @app.route("/rdkit-proxy/<path:subpath>", methods=["GET", "POST", "PUT", "OPTIONS"])
    def _rdkit_proxy(subpath: str):
        if request.method == "OPTIONS":
            return Response(
                status=204,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            )
        return _proxy_to_rdkit(subpath)

    @app.route("/app/piano-embed/", defaults={"subpath": "index.html"})
    @app.route("/app/piano-embed/<path:subpath>")
    def _piano_embed_static(subpath: str):
        """MusicMol_0322 完整钢琴（与 :5020 根目录 index 一致）；HTML 内联注入合一 API / paino-stream 基址。"""
        return _serve_musicmol_root_subpath(subpath, inject_html=True)

    @app.route("/app/mm-piano/", defaults={"subpath": ""})
    @app.route("/app/mm-piano/<path:subpath>")
    def _mm_piano_public(subpath: str):
        """单页合一：PainoJS 引用 /app/mm-piano/*.js|css|vendor（不对 HTML 注入，避免误用）。"""
        if not (subpath or "").strip():
            return Response("use /app/mm-piano/musicmol-piano.js etc.", 404)
        if ".." in subpath or subpath.startswith(("/", "\\")):
            return Response("bad path", 400)
        root = _MM_PIANO_ROOT
        if not root.is_dir():
            return Response("mm-piano root missing", 404)
        try:
            fp = (root / subpath).resolve()
            fp.relative_to(root)
        except ValueError:
            return Response("not found", 404)
        except OSError:
            return Response("not found", 404)
        if not fp.is_file():
            return Response("not found", 404)
        return send_from_directory(str(root), subpath)

    @app.route("/app/packages/<path:filename>")
    def _packages_static(filename: str):
        """顶层共享前端包 packages/ 经 /app/packages/* 提供（前端 import map @mm/* 指向此处）。"""
        if ".." in filename or filename.startswith(("/", "\\")):
            return Response("bad path", 400)
        root = _PACKAGES_ROOT.resolve()
        try:
            fp = (root / filename).resolve()
            fp.relative_to(root)
        except (OSError, ValueError):
            return Response("not found", 404)
        if not fp.is_file():
            return Response("not found", 404)
        return send_from_directory(str(root), filename)

    @app.route("/app/", defaults={"filename": "index.html"})
    @app.route("/app/<path:filename>")
    def _painojs_app_static(filename: str):
        if ".." in filename or filename.startswith(("/", "\\")):
            return Response("bad path", 400)
        # 默认进入单页合一（/app/unified-single.html）；?unifiedShell=1 为旧双 iframe 顶栏；?standalone=1 仅展陈
        if filename == "index.html":
            if request.args.get("unifiedShell") is None and request.args.get("standalone") is None:
                qs = request.query_string.decode("utf-8") if request.query_string else ""
                target = "/app/unified-single.html" + (("?" + qs) if qs else "")
                return redirect(target, code=_UNIFIED_PAINO_INDEX_REDIRECT)
        root = _PAINOJS_ROOT.resolve()
        try:
            fp = (root / filename).resolve()
        except OSError:
            return Response("not found", 404)
        try:
            fp.relative_to(root)
        except ValueError:
            return Response("not found", 404)
        if not fp.is_file():
            return Response("not found", 404)
        if filename.endswith(".html"):
            raw = fp.read_bytes()
            raw = _inject_unified_head(raw)
            return Response(raw, mimetype="text/html; charset=utf-8")
        return send_from_directory(str(root), filename)

    def _unified_root_redirect():
        return redirect("/app/unified-single.html", code=302)

    app.view_functions["_serve_index"] = _unified_root_redirect
    app.view_functions["_serve_index_explicit"] = _unified_root_redirect
    app._musicmol_unified_inited = True
    print(f"[unified] mm-piano (no html inject) -> {_MM_PIANO_ROOT} under /app/mm-piano/*")
    print(f"[unified] piano-embed -> {_PIANO_EMBED_ROOT} under /app/piano-embed/*")
    print(f"[unified] PainoJS static -> {_PAINOJS_ROOT} under /app/")
    print("[unified] root / -> /app/unified-single.html")
    print("[unified] /app/index.html (无 unifiedShell/standalone) -> /app/unified-single.html")
    print("[unified] RDKit embed -> /rdkit-proxy/* (internal uvicorn)")
