#!/bin/bash
# 合一模式：PainoJS + MusicMol 单进程（默认 9080）。须与「音乐到分子」同一 Python 环境安装 torch/selfies。
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../apps/api"

if [ -f /home/user/anaconda3/etc/profile.d/conda.sh ]; then
  # shellcheck source=/dev/null
  source /home/user/anaconda3/etc/profile.d/conda.sh
  conda activate musicmol
fi

export MUSICMOL_UNIFIED="${MUSICMOL_UNIFIED:-1}"
export MUSICMOL_LISTEN_PORT="${MUSICMOL_LISTEN_PORT:-9080}"
export MUSICMOL_LISTEN_HOST="${MUSICMOL_LISTEN_HOST:-0.0.0.0}"
export MUSICMOL_INFERENCE_DEVICE="${MUSICMOL_INFERENCE_DEVICE:-auto}"

# 避免「预热成功 → Flask bind 失败」：在 exec 前检测端口是否可绑定
python3 <<'PY'
import os, socket, subprocess, sys


def main() -> None:
    raw = (os.environ.get("MUSICMOL_LISTEN_PORT") or "9080").strip() or "9080"
    try:
        port = int(raw)
    except ValueError:
        print(f"错误: MUSICMOL_LISTEN_PORT 不是合法整数: {raw!r}", flush=True)
        sys.exit(1)
    if port <= 0 or port > 65535:
        print(f"错误: 端口 {port} 超出范围", flush=True)
        sys.exit(1)
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
    except OSError as e:
        print(f"错误: TCP 端口 {port} 已被占用，无法启动合一服务（{e}）。", flush=True)
        try:
            r = subprocess.run(
                ["ss", "-tlnp"],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
            if r.stdout:
                needle = f":{port}"
                for line in r.stdout.splitlines():
                    if needle in line:
                        print(line, flush=True)
        except Exception:
            pass
        print(
            "请先结束占用该端口的旧 MusicMol/其它进程，或改用端口启动，例如：",
            "MUSICMOL_LISTEN_PORT=9082 bash …/start_musicmol_unified.sh",
            flush=True,
        )
        sys.exit(1)
    finally:
        s.close()


main()
PY

echo "[MusicMol unified] PYTHON=$(command -v python3 || command -v python)"
python3 -c "import sys; import torch; print('torch', torch.__version__, 'exe', sys.executable)" \
  || {
    echo "当前解释器无 PyTorch。请先: pip install -r requirements.txt（或 conda install pytorch）"
    exit 1
  }

exec python3 app.py
