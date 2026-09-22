#!/bin/bash
# MusicMol Flask 主服务启动脚本（Ubuntu）
# 默认使用 CPU 模式运行，避免 Blackwell GPU 与当前 PyTorch 版本的兼容性问题

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../apps/api"

# 激活 conda 环境
source /home/user/anaconda3/etc/profile.d/conda.sh
conda activate musicmol

# 音乐→分子推理设备：auto（默认，无 GPU 时自动 cpu）| cpu | cuda
export MUSICMOL_INFERENCE_DEVICE="${MUSICMOL_INFERENCE_DEVICE:-auto}"
# 如需强制 CPU 模式，可同时取消注释下一行
# export CUDA_VISIBLE_DEVICES=""

# 本项目 API 监听端口（MusicMol，默认 5020）
export MUSICMOL_LISTEN_PORT="${MUSICMOL_LISTEN_PORT:-5020}"
# 监听地址：默认 0.0.0.0 可从局域网其它设备访问；若仅本机可改为 127.0.0.1
export MUSICMOL_LISTEN_HOST="${MUSICMOL_LISTEN_HOST:-0.0.0.0}"

# 当前上网网卡的 IPv4（换网线插口 / DHCP 后会变）：优先默认路由源地址，避免写死旧 IP
_LAN_IP=""
if command -v ip >/dev/null 2>&1; then
  _LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
fi
if [ -z "${_LAN_IP}" ] && command -v hostname >/dev/null 2>&1; then
  _LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]/ && $0 !~ /^127\./ {print; exit}')"
fi

# 外发 8082：未手动指定时 = 本机当前局域网 IP（与映射展陈一致）；纯本机可 export MUSICMOL_OUTBOUND_BASE=http://127.0.0.1:8082
if [ -z "${MUSICMOL_OUTBOUND_BASE:-}" ]; then
  if [ -n "${_LAN_IP}" ]; then
    export MUSICMOL_OUTBOUND_BASE="http://${_LAN_IP}:8082"
  else
    export MUSICMOL_OUTBOUND_BASE="http://127.0.0.1:8082"
  fi
else
  export MUSICMOL_OUTBOUND_BASE="${MUSICMOL_OUTBOUND_BASE}"
fi

# 映射端 API 记录：JSONL 写入 MusicMol_0322/logs/（app.py 内建）
# - mapping_api.log：关键 /api 请求（含模式切换 POST、外发 MIDI 等）
# - mapping_poll_state.log：后台轮询当前 piano_interaction_mode
# MUSICMOL_MAPPING_POLL_DISABLE=1 可关闭轮询日志；MUSICMOL_MAPPING_LOG_PIANO_GET_MIN_SEC=0 可记录每次 GET 模式轮询
export MUSICMOL_MAPPING_POLL_DISABLE="${MUSICMOL_MAPPING_POLL_DISABLE:-0}"
export MUSICMOL_MAPPING_POLL_SEC="${MUSICMOL_MAPPING_POLL_SEC:-10}"
export MUSICMOL_MAPPING_LOG_PIANO_GET_MIN_SEC="${MUSICMOL_MAPPING_LOG_PIANO_GET_MIN_SEC:-12}"

echo "========================================"
echo "  MusicMol Flask 服务启动中..."
echo "  环境: musicmol (Python 3.10)  MUSICMOL_INFERENCE_DEVICE=${MUSICMOL_INFERENCE_DEVICE}"
echo "  监听: ${MUSICMOL_LISTEN_HOST}:${MUSICMOL_LISTEN_PORT}（局域网请用本机 IP）"
echo "  本机访问: http://127.0.0.1:${MUSICMOL_LISTEN_PORT}/"
if [ -n "${_LAN_IP}" ]; then
  echo "  局域网示例: http://${_LAN_IP}:${MUSICMOL_LISTEN_PORT}/"
fi
echo "  外发数据目标: ${MUSICMOL_OUTBOUND_BASE}"
echo "  映射 API 记录: 已开（MUSICMOL_MAPPING_POLL_DISABLE=${MUSICMOL_MAPPING_POLL_DISABLE}）"
echo "    → ${SCRIPT_DIR}/../apps/api/logs/mapping_api.log"
echo "    → ${SCRIPT_DIR}/../apps/api/logs/mapping_poll_state.log（每 ${MUSICMOL_MAPPING_POLL_SEC}s）"
echo "    GET 模式轮询节流: ${MUSICMOL_MAPPING_LOG_PIANO_GET_MIN_SEC}s/客户端IP（0=全记）"
echo "  若其它机器无法打开页面，请检查防火墙是否放行 TCP ${MUSICMOL_LISTEN_PORT}（如: sudo ufw allow ${MUSICMOL_LISTEN_PORT}/tcp）"
echo "  端口映射参考（换网口后请用上面「局域网示例」IP 更新路由器转发）:"
echo "    · NAT: 外网 TCP -> 本机 ${_LAN_IP:-<本机当前IP>}:${MUSICMOL_LISTEN_PORT}（MusicMol）与同 IP:8082（接收端，若同机）"
echo "    · PAINOJS 8766 等同理指向当前 ${_LAN_IP:-本机IP}"
echo "    · SSH: ssh -L ${MUSICMOL_LISTEN_PORT}:127.0.0.1:${MUSICMOL_LISTEN_PORT} user@<服务器>"
echo "    · cloudflared: cloudflared tunnel --url http://127.0.0.1:${MUSICMOL_LISTEN_PORT}"
echo "========================================"

python app.py
