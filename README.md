# MusicMol: Molecule <-> Music Interactive System

> Public source release: deployment-specific infrastructure, model weights,
> datasets, runtime logs, and dependency caches are intentionally excluded.

**分子 ⇄ 音乐** 双向映射的展陈互动系统：用户在化学元素钢琴上演奏或提交 MIDI，由深度学习模型生成候选分子（SMILES）；亦可从分子结构生成可演奏音乐，并在 Three.js 大屏、玻璃分子盒与数据大屏中可视化。

## Highlights

- **Music to molecule**：MIDI 经 tokenization 与 sequence-to-sequence 推理生成候选 SELFIES/SMILES，并以 beam search 与分子质量指标筛选结果。
- **Molecule to music**：SMILES 映射为可播放的 MIDI 事件，并与钢琴界面和展陈视觉联动。
- **Interactive visualization**：Three.js 与 RDKit WASM 支持分子 3D、玻璃分子盒和数据大屏展示。
- **Unified runtime**：Flask API、静态前端、可选 RDKit 3D 服务与 UI 事件中继可统一部署。

## Public release notes

This repository contains the reproducible source code, documentation, example
configuration, and frontend assets. Model checkpoints must be supplied locally
under `packages/music-to-molecule/` before music-to-molecule inference can run.
See [DEPENDENCIES.md](DEPENDENCIES.md) for installation requirements and keep
private deployment values in `.env`, never in Git.

本仓库为 **monorepo**，包含后端推理服务与前端大屏两部分：

| 目录 | 角色 | 说明 |
|------|------|------|
| [`apps/api/`](apps/api/) | **后端** | Flask API、音乐→分子 Transformer、`molecule-to-music`、合一部署 |
| [`apps/web/`](apps/web/) | **前端** | Three.js 场景、钢琴 UI、玻璃嵌入层、效果一数据大屏 |
| [`run_unified.sh`](run_unified.sh) | **推荐启动** | 单进程合一展陈（默认端口 **9080**） |

---

## 功能概览

```
                    ┌─────────────────────────────────────────┐
                    │     浏览器 unified-single.html          │
                    │  mol2music / music2mol / 欢迎页路由      │
                    └───────────────┬─────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   PainoJS 主场景            玻璃分子盒 iframe           效果一数据大屏
   (Three.js + RDKit WASM)   (glass-molecule-demo)      (molecule-display 数据大屏)      
          │                         │                         │
          └─────────────────────────┼─────────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │  apps/api (Flask)                  │
                    │  /api/midi_exchange  音乐→分子推理       │
                    │  /api/molecule_*     分子→音乐           │
                    │  /rdkit-proxy        RDKit 3D（合一）    │
                    │  /paino-stream       UI pending（合一）  │
                    └─────────────────────────────────────────┘
```

| 方向 | 用户操作 | 技术路径 |
|------|----------|----------|
| **音乐 → 分子** | 弹琴 / 提交 MIDI →「生成分子」 | MIDI → `inference.py` Beam Search → QED 选优 → SMILES → 玻璃揭晓 → 数据大屏 |
| **分子 → 音乐** | 选择/绘制 SMILES → 播放 | SMILES → `smile_to_midi` / music21 → MIDI → 钢琴演奏 |

---

## 仓库结构

```
PC/                          ← 项目根（本 README）
├── README.md                ← 本文件
├── DEPENDENCIES.md          ← **完整依赖清单**
├── run_unified.sh           ← 合一展陈启动（推荐）
├── apps/
│   ├── api/                 ← 后端：Flask app.py、unified_runtime.py
│   │   ├── sample-midi/     ← 示例 MIDI 合集（/api/play_example_midi）
│   │   └── server/          ← local_admin_app（本地管理工具）
│   └── web/                 ← 前端
│       ├── unified-single.html  ← 展陈单页入口
│       ├── js/paino/        ← 主应用 app.js、场景、玻璃层
│       ├── mm-piano/        ← 底栏钢琴
│       └── glass-molecule-demo/
├── packages/
│   ├── music-to-molecule/   ← 音乐→分子推理：inference.py、config.json、权重 .so
│   └── molecule-to-music/   ← 分子→音乐：smile_to_midi_v10（Cython）
├── services/
│   ├── rdkit-embed/         ← RDKit 嵌入服务（/rdkit-proxy/*）
│   └── ui-poll-receiver/    ← UI 轮询接收（/paino-stream/*）
├── models/                  ← 模型权重
├── ops/                     ← 启动/部署脚本：start_flask.sh、setup_ubuntu.sh、deploy/
├── tools/                   ← playwright/截图脚本、legacy-piano/
└── docs/                    ← backend.md、delivery-spec.md、MIDI 协议
```

---

## 环境要求（摘要）

完整列表见 **[`DEPENDENCIES.md`](DEPENDENCIES.md)**。

| 类别 | 要求 |
|------|------|
| Python | **3.10**（conda 环境名建议 `musicmol`） |
| Node.js | **≥ 18** |
| RDKit | conda-forge 或 pip（分子校验、QED、3D 嵌入） |
| PyTorch | ≥ 2.0（音乐→分子推理，可选 CUDA） |
| 模型权重 | `packages/music-to-molecule/model_last(2).pt` + `config.json`（[下载说明](packages/music-to-molecule/readme.md)） |

---

## 快速启动

### 方式 A：合一展陈（推荐，单端口）

```bash
# Linux：需已执行 ops/setup_ubuntu.sh 并 conda activate musicmol
cd /path/to/PC
chmod +x run_unified.sh
./run_unified.sh
```

浏览器打开：

```text
http://127.0.0.1:9080/app/unified-single.html?route=music2mol
```

可选环境变量：

```bash
export MUSICMOL_LISTEN_PORT=9080
export MUSICMOL_INFERENCE_DEVICE=auto   # auto | cpu | cuda
```

### 方式 B：前后端分离（开发联调）

```bash
# 终端 1：Flask API
cd ops && ./start_flask.sh          # :5020

# 终端 2：PainoJS 静态站
cd apps/web && npm install && npm start  # :8766

# 终端 3（可选）：8082 接收端
cd apps/web && npm run receiver:poll

# 终端 4（可选）：RDKit 3D
cd services/rdkit-embed
python -m uvicorn app:app --host 0.0.0.0 --port 8767
```

访问 `http://127.0.0.1:8766/unified-single.html?route=music2mol`，并确保前端 API 基址指向 `:5020`（见 `apps/web/README.md` 端口说明）。

---

## 常用端口

| 端口 | 服务 | 模式 |
|------|------|------|
| **9080** | 合一（静态 + API + RDKit 代理 + pending） | `run_unified.sh` 默认 |
| **5020** | MusicMol Flask API | `start_flask.sh` |
| **8766** | PainoJS 静态前端 | `npm start` |
| **8767** | RDKit 3D 嵌入 | 分离部署时 |
| **8082** | UI pending 接收端 | 分离部署时 |

---

## 部署说明

本公开仓库不包含特定服务器、域名、远程路径或运维凭据。可按本地运行方式启动合一服务：

```bash
./run_unified.sh
```

默认服务端口为 **9080**，主界面为 `http://127.0.0.1:9080/app/unified-single.html`。如需部署到生产环境，请在自己的反向代理配置中将静态资源与 `/api/*` 路径转发至该服务。

---

## 模型参数：在哪里改、怎么改

展陈 **实时推理** 与 **批处理 / notebook** 使用不同默认值。以下为权威调整位置说明。

### 一览表

| 参数 | 展陈实时默认 | 原批处理典型值 | 调整方式 |
|------|--------------|----------------|----------|
| `beam_size` | **8** | 20 | 环境变量 `MUSICMOL_BEAM_SIZE` |
| `num_return_sequences` | **8** | 20 | 环境变量 `MUSICMOL_NUM_RETURN` |
| 解码长度上限 | **≤256** | 512（config） | 环境变量 `MUSICMOL_MAX_DECODE_LEN` |
| `batch_size` | **1** | 4 | 代码内固定（在线单条） |
| 设备 | **auto** | cuda | `MUSICMOL_INFERENCE_DEVICE` |
| 候选筛选 | QED 最大 | 同左 | `inference.py`（一般不改） |
| Transformer 结构 | 见 `config.json` | 同左 | **勿改**（需与 `.pt` 权重一致） |

---

### 1. 实时 API 推理（展陈弹琴 → 生成分子）

**调用链**：浏览器 `POST /api/midi_exchange` → [`apps/api/app.py`](apps/api/app.py) 中 `_run_transformer_from_midi_path()` → [`packages/music-to-molecule/inference.py`](packages/music-to-molecule/inference.py) 的 `run_inference()`。

#### 1.1 用环境变量调整（推荐，无需改代码）

在启动 **`start_flask.sh`** 或 **`run_unified.sh`** 之前导出：

```bash
# 更快（延迟更低，多样性略降）
export MUSICMOL_BEAM_SIZE=4
export MUSICMOL_NUM_RETURN=4
export MUSICMOL_MAX_DECODE_LEN=192
export MUSICMOL_INFERENCE_DEVICE=cuda   # 或 cpu / auto

# 质量优先（更慢）
export MUSICMOL_BEAM_SIZE=16
export MUSICMOL_NUM_RETURN=16
export MUSICMOL_MAX_DECODE_LEN=384
```

| 环境变量 | 读取位置（文件 · 函数） | 默认值 | 合法范围 |
|----------|-------------------------|--------|----------|
| `MUSICMOL_BEAM_SIZE` | `app.py` · `_music_mol_infer_beam_size()` | 8 | 1–32 |
| `MUSICMOL_NUM_RETURN` | `app.py` · `_music_mol_infer_num_return()` | 8 | 1–32 |
| `MUSICMOL_MAX_DECODE_LEN` | `inference.py` · `run_inference()` 内读取 | 256 | >32 时生效，与 `config.json` 的 `max_selfies_len` 取较小值 |
| `MUSICMOL_INFERENCE_DEVICE` | `app.py` · `_music_mol_inference_device()` | auto | `auto` / `cpu` / `cuda` |

**生效验证**：重启 Flask 后查看启动日志或首次推理日志中的 `beam_size` / `num_return_sequences`；若仍为 20，说明环境变量未传入当前进程。

#### 1.2 改代码默认值（不推荐，仅当无法设环境变量）

| 文件 | 约行号 | 修改内容 |
|------|--------|----------|
| [`apps/api/app.py`](apps/api/app.py) | `_music_mol_infer_beam_size` | 将 `os.environ.get("MUSICMOL_BEAM_SIZE") or "8"` 中的 `"8"` 改为目标值 |
| 同上 | `_music_mol_infer_num_return` | 将 `"8"` 改为目标值 |
| [`packages/music-to-molecule/inference.py`](packages/music-to-molecule/inference.py) | `run_inference()` | 将 `MUSICMOL_MAX_DECODE_LEN` 默认 `"256"` 改为目标值 |

`app.py` 中传入 `run_inference(..., beam_size=beam_n, num_return_sequences=ret_n, repeat_token_penalty=0, batch_size=1, seed=42)`，**不要**在未重训模型的情况下修改 `config.json` 中的 `d_model`、`num_encoder_layers` 等结构参数。

#### 1.3 批处理 / 离线评测（非展陈 API）

| 文件 | 说明 |
|------|------|
| [`packages/music-to-molecule/run_london_bridge.py`](packages/music-to-molecule/run_london_bridge.py) | 示例：`beam_size=32, num_return_sequences=20` |
| 命令行 / notebook | 直接调用 `run_inference(..., beam_size=..., num_return_sequences=...)` |

批处理参数 **不会** 自动影响 Flask API；展陈只看环境变量 + `app.py` 封装。

---

### 2. 模型结构与权重（训练配置，展陈一般不改）

| 文件 | 内容 |
|------|------|
| [`packages/music-to-molecule/config.json`](packages/music-to-molecule/config.json) | `d_model`、`num_encoder_layers`、`max_midi_len`、`max_selfies_len` 等 |
| `packages/music-to-molecule/model_last(2).pt` | 预训练权重，须与 `config.json` 匹配 |

更换权重或结构后需重新验证 `POST /api/midi_exchange` 与启动预热日志中的 `top1_smiles_validity`。

---

### 3. 展陈前端可视化参数（非神经网络）

不改变 SMILES 推理结果，仅影响画面与布局。

| 调参 | 默认值 | 修改位置 | 改法示例 |
|------|--------|----------|----------|
| 地面元素汤球大小 | `ballScale=1.3` | [`apps/web/unified-single.html`](apps/web/unified-single.html) `data-glass-src`；[`apps/web/glass-molecule-demo/main.js`](apps/web/glass-molecule-demo/main.js) `EMBED_EXHIBITION_BALL_SCALE` | URL `?ballScale=1.2` 或改 `data-glass-src` |
| 汤球数量 | 188（`perf=1` → 128） | `glass-molecule-demo/main.js` · `SOUP_MAX_BALLS` | URL `?soupBalls=160` 或父页 `?perf=1` |
| 空中漂浮分子缩放 | music2mol ×0.5 | `apps/web/js/paino/scene/molecularVisual.js` · `floatingRouteScaleMul()` | 修改返回值 `0.5` |
| 玻璃轮询延迟 | 可选 80ms | `apps/web/js/paino/app.js` · `ensureGlassEmbedSrcLoaded` | 父页 URL `?embedFast=1` |
| 揭晓后数据大屏 | 效果一、整页 | `apps/web/molecule-display/effect-1.html`（`embed-unified` 样式） | CSS / 布局在 `html.embed-unified` 段 |
| 大屏下 Similar Top5 表 | 已隐藏 | `效果一.html` · `bootstrap()` | `embed-unified` 下不调用表格渲染 |

---

## 依赖安装

请阅读 **[`DEPENDENCIES.md`](DEPENDENCIES.md)**，其中包含：

- 系统与运行时要求  
- 按子项目划分的 Python / Node 包表  
- 合一 vs 分离部署的依赖对照  
- 一键安装命令  

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [**DEPENDENCIES.md**](DEPENDENCIES.md) | **依赖清单（完整）** |
| [docs/backend.md](docs/backend.md) | 后端 API、环境变量、推理说明 |
| [apps/web/README.md](apps/web/README.md) | 前端启动、端口、npm 脚本 |
| [docs/delivery-spec.md](docs/delivery-spec.md) | 交付与验收 |
| [docs/MIDI_EXCHANGE_PROTOCOL_V1.md](docs/MIDI_EXCHANGE_PROTOCOL_V1.md) | MIDI 交换协议 |
| [apps/web/DOC/](apps/web/DOC/) | 前端交付说明 |
| [packages/music-to-molecule/readme.md](packages/music-to-molecule/readme.md) | 权重下载、批处理 jsonl 格式 |
| 上文 [部署说明](#部署说明) | 本地 9080 服务与反向代理建议 |

---

## 常见问题

**反向代理返回 502？**  
确认本机 **9080** 合一服务已启动：在项目根目录执行 `./run_unified.sh`，并核对反向代理目标为 `127.0.0.1:9080`。详见 [部署说明](#部署说明)。

**推理很慢或超时？**  
降低 `MUSICMOL_BEAM_SIZE`、`MUSICMOL_NUM_RETURN`、`MUSICMOL_MAX_DECODE_LEN`；确认 GPU 是否被 `MUSICMOL_INFERENCE_DEVICE=auto` 正确使用。

**有 SMILES 但怀疑不是模型结果？**  
查看 Flask 日志是否出现「演示 SMILES」或 `inference` 导入失败；检查权重是否在 `packages/music-to-molecule/`。

**合一页 RDKit / similar-drugs 失败？**  
使用 `run_unified.sh` 时走同源 `/rdkit-proxy`；HTTPS 站点勿直连 `http://127.0.0.1:8767`（混合内容）。

**`POST /api/play_example_midi` 404？**  
示例曲目接口未实现，不影响主流程 `midi_exchange`。

---

## 许可与声明

本系统用于科研演示与展陈互动；分子与药物数据不构成医疗建议。生产部署请使用正式 WSGI、完善鉴权与合规审查。
