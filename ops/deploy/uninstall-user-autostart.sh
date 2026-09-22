#!/usr/bin/env bash
# 移除 MusicMol systemd 用户自启动
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/musicmol-flask.service"

if systemctl --user is-enabled musicmol-flask.service &>/dev/null; then
  systemctl --user disable --now musicmol-flask.service || true
fi

if [[ -f "$UNIT_FILE" ]]; then
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "已删除 $UNIT_FILE"
else
  echo "未找到单元文件: $UNIT_FILE"
fi
