# MusicMol（pinao8）—— 分子 ⇄ 音乐双向映射系统

将化学结构（SMILES）映射为可演奏 MIDI，并支持通过钢琴演奏或 MIDI 片段由深度学习模型生成候选分子结构。本仓库提供 **Flask 推理与 API 服务**、**合一展陈部署**（静态前端 + 钢琴 + RDKit 代理同端口），以及与 **PainoJS** 大屏前端的联调接口。

> **项目总览与完整依赖清单**：见上级目录 [`../README.md`](../README.md)、[`../DEPENDENCIES.md`](../DEPENDENCIES.md)。  
> **大屏前端**：展陈单页、玻璃分子盒、效果一数据大屏等 UI 在 [`../painojs/`](../painojs/)（`unified-single.html?route=music2mol`）。本文档侧重 **后端推理与部署**。

---

## 核心价值

| 方向 | 说明 |
|------|------|
| **分子 → 音乐** | SMILES → MIDI 事件 → Web Audio 演奏（规则引擎 + RDKit） |
| **音乐 → 分子** | 演奏 / MIDI → Transformer 推理 → Beam Search + **QED 筛选** → 最优 SMILES |

---

## 仓库结构（摘要）

```
pinao8/
├── README.md                              # 本文件
├── docs/软件项目开发交付说明书.md           # 架构、部署、验收、术语（交付用）
├── MIDI_EXCHANGE_PROTOCOL_V1.md           # MIDI 交换协议
├── start_flask.sh                         # Linux：仅 Flask API（默认 :5020）
├── setup_ubuntu.sh                        # Ubuntu：conda 环境一键搭建示例
├── deploy/                                # systemd 用户服务安装脚本
├── model_last(2).pt                       # 音乐→分子预训练权重（需复制到 音乐到分子/）
├── MusicMol_0322/                         # 主应用：app.py、合一部署 unified_runtime.py
│   ├── app.py                             # Flask API、实时推理入口
│   ├── unified_runtime.py                 # MUSICMOL_UNIFIED=1 时挂载 PainoJS 静态站
│   ├── requirements.txt
│   └── docs/                              # API 与前端对接说明
├── 音乐到分子/                             # 推理代码 inference.py、config.json、示例 MIDI
└── 分子到音乐/                             # 分子→音乐 Python 包（服务端调用）
```

---

## 部署模式

| 模式 | 启动方式 | 默认端口 | 说明 |
|------|----------|----------|------|
| **API 独立** | `./start_flask.sh` | **5020** | 仅 MusicMol Flask；前端需另起 PainoJS（如 :8766） |
| **合一展陈** | `MUSICMOL_UNIFIED=1` + `python app.py`（见交付说明） | **9080** | 同进程提供 `/app/unified-single.html`、API、`/rdkit-proxy`、`/paino-stream` |

合一模式下浏览器访问示例：`http://<主机>:9080/app/unified-single.html?route=music2mol`。

---

## 环境要求

- **Python 3.10**（推荐 conda 环境 `musicmol`）
- **RDKit**（conda-forge）
- **PyTorch**（可选 GPU；由 `MUSICMOL_INFERENCE_DEVICE` 控制）
- 浏览器支持 **Web Audio**（首次发声需用户手势）
- 权重文件：见 [`音乐到分子/readme.md`](音乐到分子/readme.md)（网盘链接）

```bash
conda activate musicmol
cd MusicMol_0322 && pip install -r requirements.txt
```

---

## 快速启动（Linux）

### 仅 API（5020）

```bash
cd /path/to/pinao8
./start_flask.sh
```

浏览器（若使用内置钢琴页）：`http://127.0.0.1:5020/`

### 合一展陈（推荐）

在 `MusicMol_0322` 目录配置 PainoJS 静态资源路径（见 `unified_runtime.py` 中 `_PC_ROOT` / `mm-piano`），并设置：

```bash
export MUSICMOL_UNIFIED=1
export MUSICMOL_LISTEN_PORT=9080   # 可按现场修改
python app.py
```

访问：`http://127.0.0.1:9080/app/unified-single.html?route=music2mol`

---

## 环境变量（常用）

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `MUSICMOL_LISTEN_HOST` | `0.0.0.0` | API 监听地址 |
| `MUSICMOL_LISTEN_PORT` | `5020`（合一常为 `9080`） | 监听端口 |
| `MUSICMOL_INFERENCE_DEVICE` | `auto` | 推理设备：`auto` / `cpu` / `cuda` |
| `MUSICMOL_BEAM_SIZE` | **`8`** | Beam Search 宽度（见下节） |
| `MUSICMOL_NUM_RETURN` | **`8`** | 返回候选序列数上限 |
| `MUSICMOL_MAX_DECODE_LEN` | **`256`** | 解码最大 token 数上限（相对 config 中 `max_selfies_len` 取 min） |
| `MUSICMOL_OUTBOUND_BASE` | 启动脚本注入局域网 IP `:8082` | 外发 SMILES/MIDI 至 PainoJS 接收端 |
| `MUSICMOL_OUTBOUND_ENABLE` | `1` | 设为 `0` 关闭外发 |
| `MUSICMOL_UNIFIED` | 未设 | 设为 `1` 启用合一静态站 + 内嵌 RDKit 代理 |

完整列表与映射日志、管理端等见 [`docs/软件项目开发交付说明书.md`](docs/软件项目开发交付说明书.md)。

---

## 模型参数优化说明

本节说明 **相对原始 notebook / 批处理脚本**（`beam_size=20`、`num_return_sequences=20`）在 **实时展陈推理** 中已调整的参数及原因。实现位置：`MusicMol_0322/app.py` → `音乐到分子/inference.py`。

### 1. 推理超参（实时 API：`POST /api/midi_exchange` 等）

| 参数 | 原典型值 | **当前默认** | 环境变量 | 调整说明 |
|------|----------|--------------|----------|----------|
| `beam_size` | 20 | **8** | `MUSICMOL_BEAM_SIZE` | 展陈现场需 **数秒内** 返回 SMILES；beam 过宽时 GPU/CPU 延迟明显上升。有效范围 **1–32**。 |
| `num_return_sequences` | 20 | **8** | `MUSICMOL_NUM_RETURN` | 与 beam 同步收紧；实际解码时取 `min(beam_size, num_return_sequences, 32)`。 |
| `max_decode`（SELFIES 长度） | 512（config） | **≤256** | `MUSICMOL_MAX_DECODE_LEN` | 在 `config.json` 的 `max_selfies_len` 基础上再封顶，缩短解码步数、降低超时概率。 |
| `batch_size` | 4（批处理示例） | **1** | — | 在线单条 MIDI 推理固定为 1，避免批等待。 |
| `repeat_token_penalty` | 0 | **0** | — | 保持与训练脚本一致，未启用重复惩罚。 |
| `seed` | 42 | **42** | — | 固定随机种子，便于复现。 |
| **候选筛选** | QED 最大 | **QED 最大** | — | 对每个 beam 候选计算 RDKit **QED**；在 **SMILES/SELFIES 合法** 候选中取 QED 最高者为 `best`（逻辑未改，见 `inference.py`）。 |
| `device` | cuda | **auto** | `MUSICMOL_INFERENCE_DEVICE` | 有 GPU 用 CUDA，否则 CPU；避免无 GPU 环境硬绑 cuda 导致推理失败。 |

**调参示例（更快但略降多样性）：**

```bash
export MUSICMOL_BEAM_SIZE=4
export MUSICMOL_NUM_RETURN=4
export MUSICMOL_MAX_DECODE_LEN=192
./start_flask.sh
```

**调参示例（质量优先、可接受更慢）：**

```bash
export MUSICMOL_BEAM_SIZE=16
export MUSICMOL_NUM_RETURN=16
export MUSICMOL_MAX_DECODE_LEN=384
export MUSICMOL_INFERENCE_DEVICE=cuda
./start_flask.sh
```

### 2. 模型结构权重（未改）

`音乐到分子/config.json` 中 Transformer 结构参数（`d_model=512`、`num_encoder_layers=6` 等）与 checkpoint **`model_last(2).pt`** 一致，**展陈运行时未修改网络结构**，仅调整解码与搜索宽度。

### 3. 推理不可用时的回退

若未安装 PyTorch、权重缺失或 `inference` 导入失败，`app.py` 会回退到 **演示 SMILES**（按 MIDI 音符哈希映射），保证钢琴端仍可联调 UI；生产展陈须保证 conda 环境与权重完整。启动日志中可见预热结果，例如：

```text
top1_smiles_validity: 1.0
beam_size: 8
num_return_sequences: 8
```

（若日志仍为 `20`，说明环境变量未生效或使用了旧进程，请重启服务并检查 `MUSICMOL_BEAM_SIZE`。）

---

## 展陈端可视化调参（PainoJS，与模型并列说明）

以下在 **前端** 调整，不改变 Transformer 权重，用于 music2mol 展陈体验。代码在 [`../painojs/`](../painojs/)。

| 调参项 | 当前值 | 位置 | 说明 |
|--------|--------|------|------|
| 地面元素汤球缩放 | **`ballScale=1.3`**（+30%） | `glass-molecule-demo/main.js`、`unified-single.html` `data-glass-src` | 玻璃盒内地面小球半径；可由 URL `?ballScale=` 覆盖。 |
| 汤球数量（性能） | 默认 188；`?perf=1` → **128** | `glass-molecule-demo/main.js` `SOUP_MAX_BALLS` | 降低 O(n²) 碰撞开销。 |
| 空中漂浮分子 | music2mol 路由 **×0.5** | `painojs/js/paino/scene/molecularVisual.js` `floatingRouteScaleMul()` | 主场景漂浮球棍缩小，突出玻璃盒内元素汤。 |
| 揭晓后数据大屏 | **效果一** 模板、**整页** overlay | `效果一.html?embed=unified`、`unified-single.css` | 大屏铺满视口；**底部 Similar Top5 表已隐藏**（数据仍预取供飞跃末全屏揭晓）。 |
| 实时轮询 | `?embedFast=1` / `lowLatencyPoll=1` | `app.js` `ensureGlassEmbedSrcLoaded` | 父页参数透传至玻璃 embed，缩短 pending 轮询间隔。 |

---

## 主要 API（摘要）

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/midi_exchange` | POST | 上传 MIDI 事件 → 推理 → 返回 SMILES（核心） |
| `/api/midi_exchange/ui_pending` | GET | 前端轮询待展示结果 |
| `/api/piano_interaction_mode` | GET/POST | 钢琴交互模式 |
| `/api/molecule_music_ui_pending` | GET | 分子→音乐 pending |
| `/api/status_lite` | GET | 轻量健康状态 |

详见 [`MusicMol_0322/docs/FRONTEND_API_IN_USE.md`](MusicMol_0322/docs/FRONTEND_API_IN_USE.md)、[`MIDI_EXCHANGE_PROTOCOL_V1.md`](MIDI_EXCHANGE_PROTOCOL_V1.md)。

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/软件项目开发交付说明书.md](docs/软件项目开发交付说明书.md) | 交付说明：架构、部署运维、验收、术语 |
| [MusicMol_0322/docs/API_INTEGRATION.md](MusicMol_0322/docs/API_INTEGRATION.md) | API 集成 |
| [MusicMol_0322/docs/FRONTEND_API_IN_USE.md](MusicMol_0322/docs/FRONTEND_API_IN_USE.md) | 端口角色与接口清单 |
| [MIDI_EXCHANGE_PROTOCOL_V1.md](MIDI_EXCHANGE_PROTOCOL_V1.md) | MIDI 交换协议 |
| [音乐到分子/readme.md](音乐到分子/readme.md) | 批处理推理、权重下载、jsonl 格式 |
| [../painojs/README.md](../painojs/README.md) | PainoJS 大屏前端、端口 8766/8767/8082 |

---

## 常见问题

**Q：点击「生成分子」很慢或超时？**  
先确认 `MUSICMOL_INFERENCE_DEVICE` 与 GPU 是否可用；可临时降低 `MUSICMOL_BEAM_SIZE` / `MUSICMOL_NUM_RETURN` / `MUSICMOL_MAX_DECODE_LEN`。

**Q：返回 SMILES 但不像「真模型」？**  
查看 Flask 日志是否出现「演示 SMILES」或 inference 导入失败；检查 `音乐到分子/model_last(2).pt` 与 `config.json`。

**Q：`POST /api/play_example_midi` 404？**  
示例曲目接口未实现，**不影响**弹琴 → `midi_exchange` 主流程。

**Q：合一部署下 RDKit / similar-drugs 失败？**  
HTTPS 页面需走同源 `/rdkit-proxy`；见 `unified_runtime.py` 注入的 `MUSICMOL_UNIFIED_SERVER` 与交付说明中的混合内容说明。

---

## 许可证与声明

本项目为实验性跨学科演示系统。生产环境请使用正式 WSGI、替换内存队列，并单独评估安全、药物数据与合规要求。
