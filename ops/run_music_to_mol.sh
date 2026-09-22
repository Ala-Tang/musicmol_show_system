#!/bin/bash
# 音乐 → 分子 Transformer 推理启动脚本（Ubuntu）
# 使用 CPU 模式运行，避免 Blackwell GPU 兼容性问题

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/音乐到分子"

# 激活 conda 环境
source /home/user/anaconda3/etc/profile.d/conda.sh
conda activate musicmol

# 如需强制 CPU 模式，请取消注释下一行
# export CUDA_VISIBLE_DEVICES=""

echo "========================================"
echo "  音乐→分子 推理开始"
echo "  环境: musicmol (Python 3.10)"
echo "  输入: children_midi.jsonl"
echo "  输出: output_beam_qed/"
echo "========================================"

python -c "
import inference
import json

records, summary = inference.run_inference(
    config_path='./config.json',
    ckpt_path='./model_last(2).pt',
    input_list='./children_midi.jsonl',
    output_dir='./output_beam_qed',
    batch_size=4,
    seed=42,
    beam_size=32,
    num_return_sequences=20,
    repeat_token_penalty=0,
    no_repeat_ngram_size=3,
    repeat_ngram_penalty=1.5,
    top_qed_k=3,
)

print('\n========================================')
print('推理完成！')
print('========================================')
print(json.dumps(summary, ensure_ascii=False, indent=2))
"
