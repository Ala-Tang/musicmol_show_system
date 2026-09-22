# MusicMol 项目依赖清单

本文档为 **h:\zju\PC** 仓库（`apps/api` + `apps/web`）的依赖总表。安装顺序建议：**系统运行时 → conda 环境 `musicmol` → Python 包 → Node 包 → 模型权重**。

---

## 1. 系统与运行时（必需）

| 依赖 | 版本建议 | 用途 | 备注 |
|------|----------|------|------|
| **操作系统** | Ubuntu 20.04+ / Windows 10+ | 部署与开发 | 展陈现场以 Linux 为主 |
| **Python** | **3.10.x** | Flask、PyTorch、RDKit | `setup_ubuntu.sh` 创建 conda 环境 |
| **Node.js** | **≥ 18** | PainoJS 静态站、`npm install` | 见 `apps/web/package.json` `engines` |
| **npm** | 随 Node | 前端依赖与 `serve` | 国内可用 `npm run install:cn` |
| **conda** | Miniconda/Anaconda | 安装 RDKit、Python 3.10 | 推荐用 conda-forge 装 RDKit |
| **Git** | 任意较新版本 | 版本管理 | — |
| **现代浏览器** | Chrome / Edge 近期版 | WebGL、WASM、Web Audio | 勿用 `file://` 打开主站 |

### 可选（GPU 推理）

| 依赖 | 用途 |
|------|------|
| **NVIDIA 驱动 + CUDA** | `MUSICMOL_INFERENCE_DEVICE=cuda` 时加速音乐→分子 |
| **cu128 等 PyTorch wheel** | 见 `ops/setup_ubuntu.sh` 示例安装命令 |

---

## 2. Python 依赖（按子项目）

### 2.1 核心后端 `apps/api`（Flask + 推理）

**清单文件**：[`apps/api/requirements.txt`](apps/api/requirements.txt)

| 包名 | requirements 约束 | 必需 | 说明 |
|------|-------------------|------|------|
| flask | ≥2.0 | 是 | HTTP API |
| flask-cors | ≥3.0 | 是 | 跨域 |
| mido | ≥1.3 | 是 | MIDI 读写 |
| fastapi | ≥0.110 | 合一模式 | `MUSICMOL_UNIFIED=1` 内嵌 RDKit 代理 |
| uvicorn[standard] | ≥0.27 | 合一模式 | 同上 |
| torch | ≥2.0 | 音乐→分子 | Transformer 推理 |
| selfies | ≥2.1 | 音乐→分子 | 序列编解码 |
| **rdkit** | — | 是 | **推荐** `conda install -c conda-forge rdkit`；QED、SMILES 校验 |

**`setup_ubuntu.sh` 额外安装（批处理 / 训练 / 完整环境）**：

| 包名 | 必需 | 说明 |
|------|------|------|
| music21 | 可选 | `packages/molecule-to-music/README.md` 示例环境；服务端生成路径不依赖该包 |
| miditok | 推荐 | 日志中 tokenizer 预热会用到 |
| numpy | 是 | 数值计算 |
| matplotlib | 批处理可视化 | `packages/music-to-molecule/view.py` |
| tqdm | 批处理 | 进度条 |
| jupyter | 可选 |  notebook 调试 |

### 2.2 音乐→分子推理模块 `packages/music-to-molecule/`

| 包名 | 必需 | 说明 |
|------|------|------|
| torch | 是 | 见 `inference.py` |
| selfies | 是 | SELFIES 解码 |
| rdkit | 是 | QED、SMILES 合法性 |
| mido | 是 | MIDI → token |
| 标准库 | — | json, pathlib 等 |

**模型权重（非 pip 包）**：

| 文件 | 位置 | 说明 |
|------|------|------|
| `model_last(2).pt` 或 `model_last.pt` | `packages/music-to-molecule/` 或仓库根 | 见 [`packages/music-to-molecule/readme.md`](packages/music-to-molecule/readme.md) 网盘 |
| `config.json` | `packages/music-to-molecule/` | 与权重匹配的 Transformer 配置 |

### 2.3 分子→音乐 `packages/molecule-to-music/`

| 包名 | 必需 | 说明 |
|------|------|------|
| music21 | 是 | 见 [`packages/molecule-to-music/README.md`](packages/molecule-to-music/README.md) |
| rdkit | 是 | 结构解析 |
| smile_to_midi_v10（Cython） | 是 | `packages/molecule-to-music` 内编译扩展；失败则分子→音乐返回生成失败 |

### 2.4 PainoJS RDKit 嵌入服务 `services/rdkit-embed/`

**清单文件**：[`services/rdkit-embed/requirements.txt`](services/rdkit-embed/requirements.txt)

| 包名 | 约束 | 端口 | 说明 |
|------|------|------|------|
| rdkit | ≥2022.9.1 | **8767** | 真 3D 构象（ETKDG + MMFF） |
| fastapi | ≥0.110 | 8767 | REST API |
| uvicorn[standard] | ≥0.27 | 8767 | ASGI 服务 |

> **合一部署**（`run_unified.sh`）时，RDKit 服务由 Flask 进程内嵌，浏览器走同源 `/rdkit-proxy`，**无需单独起 8767**。

### 2.5 PainoJS 接收端 `services/ui-poll-receiver/`

| 依赖 | 说明 |
|------|------|
| **仅 Python 3 标准库** | `http.server`，无第三方 pip 包 |
| 默认端口 **8082** | 合一模式下由 `unified_runtime` 内嵌为 `/paino-stream` |

### 2.6 其他 Python 目录（一般展陈不启用）

| 路径 | 清单 | 说明 |
|------|------|------|
| `apps/web/glass-molecule-demo/requirements.txt` | 独立演示 | 非合一主路径 |
| `apps/web/space/backend/requirements.txt` | Space 子项目 | 扩展演示 |
| `apps/web/musicmol_vs/**/requirements.txt` | 历史副本 | 以 `apps/api` + `apps/web` 主路径为准 |

---

## 3. Node.js / 前端依赖（`apps/web`）

**清单文件**：[`apps/web/package.json`](apps/web/package.json)

### 3.1 生产依赖 `dependencies`

| 包名 | 版本 | 说明 |
|------|------|------|
| three | 0.170.0 | Three.js 主场景 |
| playwright | ^1.59.1 | 诊断/自动化脚本（非浏览器运行时必需） |

### 3.2 开发 / 构建 `devDependencies`（`postinstall` 会 vendor 到本地）

| 包名 | 版本 | 说明 |
|------|------|------|
| @rdkit/rdkit | 2025.3.4-1.0.0 | RDKit WASM（`vendor/rdkit`） |
| 3dmol | ^2.5.4 | 分子 3D 查看（`vendor/3dmol`） |
| vite | ^5.4.11 | Galactic 子项目构建 |

### 3.3 运行时通过 CDN / vendor 引入（非 npm 主依赖）

| 资源 | 位置 | 说明 |
|------|------|------|
| Three.js 副本 | `apps/web/vendor/three` | `postinstall` 同步 |
| Tone.js | `glass-molecule-demo/vendor/tone` | 玻璃盒音频 |
| @tonejs/midi | `glass-molecule-demo/vendor/midi` | MIDI 解析 |
| Chart.js | 大屏模板内引用 | 备用 molecule-dashboard |

### 3.4 前端全局 CLI（npx，非 package.json 锁定）

| 工具 | 用途 |
|------|------|
| `serve` | `npm start` → 静态站 **:8766** |

---

## 4. 一键安装命令参考

### Linux（推荐，与现场一致）

```bash
# 1. Conda 环境（首次）
cd ops && bash setup_ubuntu.sh

# 2. 激活并安装 Flask 侧 pip 清单
conda activate musicmol
pip install -r apps/api/requirements.txt

# 3. 前端
cd apps/web && npm install
# 国内镜像：npm run install:cn
```

### Windows（开发）

```powershell
conda create -n musicmol python=3.10 -y
conda activate musicmol
conda install -c conda-forge rdkit -y
pip install -r apps/api/requirements.txt
cd apps/web
npm install
```

### 模型权重

将 `model_last(2).pt` 放到 `packages/music-to-molecule/`，并确保同目录有 `config.json`。

---

## 5. 依赖与部署模式对照

| 模式 | 启动脚本 | 对外端口 | 需要单独起 8766？ | 需要单独起 8082？ | 需要单独起 8767？ |
|------|----------|----------|-------------------|-------------------|-------------------|
| **合一展陈（推荐）** | [`run_unified.sh`](run_unified.sh) | **9080**（可改） | 否 | 否（内嵌 `/paino-stream`） | 否（内嵌 `/rdkit-proxy`） |
| API + 前端分离 | `apps/api/start_flask.sh` + `apps/web/npm start` | 5020 + 8766 + 8082 + 8767 | 是 | 是（或 `npm run receiver:poll`） | 可选 |

---

## 6. 版本记录

| 日期 | 说明 |
|------|------|
| 2026-05 | 初版：汇总 pinao8 / painojs 主路径依赖；实时推理默认 beam=8、return=8 |

维护时请同步更新：`apps/api/requirements.txt`、`apps/web/package.json`、本文件。
