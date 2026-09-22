# MusicMo: Mol2Music Inference

预训练模型可在以下链接下载：  
**链接**：https://pan.quark.cn/s/a68573d3bbb3

## 简介
该项目用于从 MIDI 文件生成分子表示（SELFIES/SMILES），并使用 beam search 产生多个候选，再从中选择 QED 最大 的合法分子作为最终结果。

### 当前推理策略：

使用 beam search
返回 top-k 候选（默认 20 个）
不使用长度惩罚
对每个候选计算 QED
最终从合法分子中选择 QED 最大 的结果作为 best
### 主要功能
从输入的 jsonl 文件读取 MIDI 路径
将 MIDI 编码为 token
使用训练好的 MusicToSmilesTransformer 进行推理
生成多个 SELFIES / SMILES 候选
检查 SELFIES 和 SMILES 合法性
计算 QED 分数
保存详细预测结果和汇总结果
### 输入格式
输入文件为 `jsonl`，每行一个样本，例如：
```
json
{"id": "sample_001", "midi_path": "./midi/a.mid"}
{"id": "sample_002", "midi_path": "./midi/b.mid"}

id：样本编号，可选
midi_path：MIDI 文件路径，必填
```
### 输出文件
运行后会在输出目录下生成：

bash
output_beam_qed/
├── figures/
├── predictions_topk.jsonl
└── summary.json
说明：

predictions_topk.jsonl：每个样本的 top-k 候选及 best 结果
summary.json：整体统计信息
figures/：当前代码仅创建目录，不会自动生成图片