# MusicMol 2.0 / PainoJS（化学元素钢琴大屏可视化）

> **项目总览与完整依赖清单**：见上级目录 [`../README.md`](../README.md)、[`../DEPENDENCIES.md`](../DEPENDENCIES.md)。后端 API 与模型推理见 [`../pinao8/README.md`](../pinao8/README.md)。

大屏互动前端：**Three.js** 场景（点云波浪、环境光、后期合成）+ **漂浮分子球棍**（**RDKit WASM** 解析 SMILES，可选 **Python RDKit 嵌入服务** 输出真 3D 构象）+ **MusicMol** 展陈联动（分子⇄音乐、玻璃嵌入层、会话推送等）。

- **页面标题**：MusicMol 2.0（见根目录 `index.html`）  
- **npm 包名**：`piano`（`package.json`）  
- **详细交付说明**（架构、业务、运维、验收、术语）：[`DOC/软件项目开发交付说明书.md`](DOC/软件项目开发交付说明书.md)

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 分子可视化 | SMILES → RDKit → MolBlock/PDB → Three.js 球棍 / InstancedMesh |
| 音乐互动 | MIDI 驱动点云与特效；与外部 **5020** MusicMol API 交换分子/音符事件 |
| 展陈接收 | **8082** `ui_poll_receiver`：轮询 pending、玻璃会话推送、手动分子音乐阶段 |
| 真 3D（可选） | **8767** FastAPI `rdkit_embed`：ETKDG + MMFF，失败回退 WASM |
| 运维辅助 | **18966** 本机管理台、连通性脚本、Playwright 诊断脚本等 |

---

## 环境与依赖

- **Node.js** ≥ 18  
- **npm**：`npm install`（`postinstall` 会同步 `vendor/three`、`vendor/rdkit`、`3dmol` 等到本地）  
- **Python**（可选）：`server/rdkit_embed`、`server/ui_poll_receiver`、`server/local_admin_app` 等  
- **浏览器**：支持 WebGL、ES Modules、WASM；勿用 `file://` 打开主站（模块与 WASM 策略受限）

---

## 快速启动

### 仅前端静态站（默认）

```bash
npm install
npm start
```

浏览器访问 **`http://127.0.0.1:8766/`**（监听 `0.0.0.0:8766`，局域网可用本机 IP）。

### 一键拉起（Windows，含 rdkit_embed + 前端）

```bash
npm run start:all
```

### 手动启动 Python RDKit 嵌入（推荐联调真 3D）

```bash
cd server/rdkit_embed
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8767
```

健康检查：`http://127.0.0.1:8767/health`。前端通过 `RDKIT_EMBED_API_BASE` 或栈配置指向该地址；不可达时自动回退 **RDKit WASM**。

### 8082 接收端（MusicMol / 玻璃层轮询）

```bash
npm run receiver:poll
# 或：python3 server/ui_poll_receiver/app.py
```

---

## 常用端口

| 端口 | 服务 | 说明 |
|------|------|------|
| **8766** | 静态前端 | `npm start`（`serve`） |
| **8767** | `rdkit_embed` | FastAPI + RDKit 3D |
| **5020** | MusicMol 外设 API | 非本仓库默认进程；见 `API.md` |
| **8082** | `ui_poll_receiver` | PainoJS 侧接收与 pending |
| **18966** | `local_admin_app` | 本机管理台（默认仅 127.0.0.1） |

**注意**：主站按页面 **hostname** 推导 `MUSICMOL_API_BASE`（5020）与 `MUSICMOL_UI_POLL_BASE`（8082）。若用局域网 IP 打开页面而外设只监听 `127.0.0.1`，会出现请求不通——需外设监听 `0.0.0.0` 或使用文档中的 loopback 覆盖参数。HTTPS 页面访问 HTTP 的 8767/5020 会触发**混合内容拦截**，见 `server/rdkit_embed/README.md`。

---

## npm 脚本摘录

| 脚本 | 作用 |
|------|------|
| `npm start` | 启动静态站 :8766 |
| `npm run receiver:poll` | 8082 接收端 |
| `npm run admin:local` | 本机管理台 |
| `npm run check:exhibition` | 展陈连通性检查 |
| `npm run vendor-three` / `vendor-rdkit` | 刷新 vendor 副本 |
| `npm run dev:galactic` / `build:galactic` | Galactic 子项目 Vite |

完整列表见 `package.json`。

---

## 仓库目录（核心）

```
├── index.html              # 主入口页面
├── css/                    # 全局与应用样式
├── js/paino/               # 主应用模块（app.js、分子、场景、MusicMol API、玻璃层等）
├── vendor/                 # three、rdkit wasm、3dmol 等本地副本
├── server/
│   ├── rdkit_embed/        # FastAPI：3D 嵌入
│   ├── ui_poll_receiver/   # 8082 HTTP 接收与队列
│   └── local_admin_app/    # 本机管理台
├── DOC/                    # 设计与接口文档
├── scripts/                # 运维与诊断脚本
├── space/                  # 星空/扩展演示与素材
└── glass-molecule-demo/    # 玻璃分子演示页
```

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [DOC/软件项目开发交付说明书.md](DOC/软件项目开发交付说明书.md) | **交付说明**：架构、业务、部署、操作、验收、术语 |
| [DOC/本项目实现技术路径.md](DOC/本项目实现技术路径.md) | 从加载到渲染的代码级数据流 |
| [API.md](API.md) | MusicMol 5020 REST 接口（分子↔音乐等） |
| [MUSICMOL_INTEGRATION_API.md](MUSICMOL_INTEGRATION_API.md) | PainoJS 与 MusicMol 集成流程 |
| [DOC/EXTERNAL_DATA_RECEIVER_API.md](DOC/EXTERNAL_DATA_RECEIVER_API.md) | 外设数据接收与 hostname 行为 |
| [DOC/GLASS_SESSION_PUSH_API.md](DOC/GLASS_SESSION_PUSH_API.md) | 玻璃会话推送 |
| `server/rdkit_embed/README.md` | 8767 服务说明与 HTTPS 反代 |

---

## 推送到 Gitee（简要）

1. 在 Gitee 新建空仓库（可不勾选「使用 Readme 初始化」）。  
2. `git remote add origin https://gitee.com/<用户>/<仓库>.git`  
3. `git push -u origin master`（若默认分支为 `main` 则改用 `main`）。

HTTPS 推送使用 Gitee **私人令牌**。首次使用 Git 请配置 `user.name` / `user.email`。

---

## 许可与声明

分子与药物展示数据仅供演示与科研可视化用途；三维几何在 WASM 路径下多为 **2D 排版抬升示意**，真 3D 以 **8767** 服务配置为准。具体边界见 `DOC/本项目实现技术路径.md` 中的说明。
