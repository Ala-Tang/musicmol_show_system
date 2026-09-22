#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/services/rdkit-embed"
PORT="${RDKIT_EMBED_PORT:-8767}"
exec python -m uvicorn app:app --host 0.0.0.0 --port "$PORT"
