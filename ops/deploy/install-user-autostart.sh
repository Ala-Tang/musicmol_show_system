#!/usr/bin/env bash
# 安装 systemd 用户服务：登录后自动启动 MusicMol Flask（默认 5020）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT/../apps/api"

_resolve_conda_base() {
  if [[ -n "${CONDA_EXE:-}" ]]; then
    dirname "$(dirname "$CONDA_EXE")"
    return
  fi
  for base in "/home/user/anaconda3" "${HOME}/anaconda3" "${HOME}/miniconda3" "${HOME}/mambaforge" "${HOME}/miniforge3"; do
    if [[ -x "$base/bin/conda" ]]; then
      echo "$base"
      return
    fi
  done
  echo ""
}

CONDA_BASE="$(_resolve_conda_base)"
if [[ -z "$CONDA_BASE" ]]; then
  echo "错误: 未找到 conda 安装目录。请设置 CONDA_EXE 或将 conda 安装在 ~/anaconda3 等常见路径。" >&2
  exit 1
fi

ENV_NAME="${MUSICMOL_CONDA_ENV:-musicmol}"
PY="$CONDA_BASE/envs/$ENV_NAME/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "错误: 未找到解释器: $PY" >&2
  echo "请先创建环境: conda create -n $ENV_NAME python=3.10 -y 并安装依赖（见 README / setup_ubuntu.sh）" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/app.py" ]]; then
  echo "错误: 未找到 $APP_DIR/app.py" >&2
  exit 1
fi

LISTEN_PORT="${MUSICMOL_LISTEN_PORT:-5020}"
if command -v fuser >/dev/null 2>&1 && fuser "${LISTEN_PORT}/tcp" >/dev/null 2>&1; then
  echo "警告: TCP ${LISTEN_PORT} 已被占用。若曾手动运行 ./start_flask.sh，请先结束该进程后再执行本脚本，否则服务会启动失败。" >&2
  echo "  查看占用: ss -tlnp | grep ${LISTEN_PORT}  或  fuser -v ${LISTEN_PORT}/tcp" >&2
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
UNIT_FILE="$UNIT_DIR/musicmol-flask.service"

cat >"$UNIT_FILE" <<EOF
[Unit]
Description=MusicMol Flask (分子⇄音乐) on port ${LISTEN_PORT}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$PY app.py
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1
Environment=MUSICMOL_LISTEN_PORT=${LISTEN_PORT}
Environment=MUSICMOL_OUTBOUND_BASE=${MUSICMOL_OUTBOUND_BASE:-http://127.0.0.1:8082}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable musicmol-flask.service
systemctl --user restart musicmol-flask.service || systemctl --user start musicmol-flask.service

echo ""
echo "已写入: $UNIT_FILE"
echo "已执行: systemctl --user enable --now musicmol-flask.service"
echo "常用命令:"
echo "  systemctl --user status musicmol-flask.service"
echo "  journalctl --user -u musicmol-flask.service -f"
echo "  systemctl --user stop musicmol-flask.service"
echo ""
echo "若需在「未登录图形界面」时也在开机启动本服务，可执行一次:"
echo "  loginctl enable-linger \"$USER\""
