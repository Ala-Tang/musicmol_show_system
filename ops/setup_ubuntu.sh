#!/bin/bash
# MusicMol Ubuntu 环境搭建脚本
# 系统要求: Ubuntu 20.04+ / 22.04 / 24.04, conda 已安装

set -e

echo "========================================"
echo "  MusicMol Ubuntu 环境搭建脚本"
echo "========================================"

# 1. 创建 Python 3.10 conda 环境
echo "[1/5] 创建 conda 环境 musicmol (Python 3.10)..."
source /home/user/anaconda3/etc/profile.d/conda.sh
conda create -n musicmol python=3.10 -y

# 2. 激活环境
echo "[2/5] 激活环境..."
conda activate musicmol

# 3. 配置 pip 国内镜像（清华源）
echo "[3/5] 配置 pip 清华镜像..."
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn

# 4. 安装依赖
echo "[4/5] 安装 Python 依赖（RDKit + PyTorch + Flask + ...）..."

# 4.1 RDKit (conda-forge)
conda install -c conda-forge rdkit -y

# 4.2 PyTorch (阿里云镜像，cu128 支持 Blackwell GPU)
pip install torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 -f https://mirrors.aliyun.com/pytorch-wheels/cu128

# 4.3 其他 Python 包
pip install flask flask-cors mido music21 matplotlib jupyter selfies tqdm miditok numpy

# 5. 验证安装
echo "[5/5] 验证安装..."
python -c "
import torch
import rdkit
from rdkit import Chem
print('PyTorch:', torch.__version__)
print('CUDA available:', torch.cuda.is_available())
print('RDKit works:', Chem.MolFromSmiles('CCO') is not None)
"

echo ""
echo "========================================"
echo "  环境搭建完成！"
echo ""
echo "  使用方法:"
echo "    conda activate musicmol"
echo "    ./start_flask.sh          # 启动 Flask 主服务"
echo "    ./run_music_to_mol.sh     # 运行音乐→分子推理"
echo "========================================"
