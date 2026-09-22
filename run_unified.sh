#!/usr/bin/env bash
# MusicMol + PainoJS 合一启动：仅一个对外 HTTP 端口（默认 9080）。
# 根路径 / 会 302 到 /app/unified-single.html（单页：展陈 + 钢琴同 document）；/app/index.html 无参数时亦同；仅展陈 /app/index.html?standalone=1；旧双 iframe 壳：/app/unified.html
# 服务启动后探活（无需 curl）：在另一终端执行
#   cd apps/api && python3 scripts/verify_unified_rdkit.py --base http://127.0.0.1:${MUSICMOL_LISTEN_PORT:-9080}
# RDKit 冷启动较慢时可加大：export MUSICMOL_RDKIT_READY_TIMEOUT_SEC=90
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MUSICMOL_UNIFIED=1
export MUSICMOL_LISTEN_HOST="${MUSICMOL_LISTEN_HOST:-0.0.0.0}"
export MUSICMOL_LISTEN_PORT="${MUSICMOL_LISTEN_PORT:-${MUSICMOL_UNIFIED_PORT:-9080}}"
cd "$ROOT/apps/api"
exec /opt/miniconda3/envs/musicmol/bin/python app.py
