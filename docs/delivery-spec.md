# MusicMol（pinao8）软件项目开发交付说明书

**文档版本**：1.0  
**适用范围**：本仓库「分子 ⇄ 音乐」一体化演示系统（Flask + 浏览器钢琴 + 大屏联调）  
**关联入口**：[README.md](../README.md)

---

## 1. 文档目的与读者

本说明书面向 **开发、测试、运维与验收方**，用于：

- 理解系统技术架构与模块边界；
- 掌握核心业务逻辑与数据流；
- 完成部署、监控与日常运维；
- 按操作说明与验收清单完成交付确认。

---

## 2. 项目概述

### 2.1 建设目标

构建 **双向闭环**：化学结构（SMILES）与音乐（MIDI/演奏事件）之间的可演示映射，支撑展陈、教研或联调场景下的「大屏 + 钢琴端」互动。

### 2.2 功能边界（摘要）

| 能力 | 实现位置（概要） |
|------|------------------|
| 分子 → 音乐 | 服务端 RDKit + 分子到音乐管线生成 MIDI 事件；浏览器可自动演奏 |
| 音乐 → 分子 | 服务端 PyTorch Transformer 推理；钢琴页一键推理 |
| 钢琴交互 UI | `MusicMol_0322/index.html`、`musicmol-piano.js` 等 |
| 大屏/外部联调 | REST API：模式切换、分子提交队列、MIDI 交换、外发 8082（接收端不在本仓库） |

### 2.3 非目标（Out of Scope）

- **8082 接收服务**：协议对接由外部程序实现，本仓库仅按约定外发或浏览器直连；
- **生产级高可用**：当前为单进程 Flask 开发服务器与内存队列；
- **跨平台二进制**：`音乐到分子` 下部分 `.so` 绑定 Python 3.10 / Linux x86_64，其它平台需重新编译。

---

## 3. 技术架构

### 3.1 逻辑架构图（文字）

```
┌─────────────────────────────────────────────────────────────────┐
│                     浏览器（钢琴页 / 映射端静态页）                   │
│  Web Audio · 轮询 API · 可选直连 8082（glass_session 等）            │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP(S)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              MusicMol Flask（MusicMol_0322/app.py）                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ 分子→音乐     │ │ 音乐→分子     │ │ 模式/队列/MIDI 交换       │ │
│  │ RDKit+MIDI    │ │ PyTorch 推理  │ │ 内存状态 + 可选外发       │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │ 可选：HTTP POST
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│           外部接收端（默认 :8082，非本仓库）                         │
│           __push/smiles · __push/midi · glass_session 等           │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 技术栈分层

| 层级 | 技术选型 |
|------|----------|
| Web 框架 | Flask、`flask-cors` |
| 化学信息学 | RDKit（SMILES 解析、校验） |
| 深度学习 | PyTorch；音乐→分子 Transformer（权重 `model_last(2).pt` → `音乐到分子/`） |
| MIDI/乐理 | mido、smile_to_midi_v10（服务端）；浏览器原生 MIDI/Audio |
| 前端 | HTML/CSS/JS；Three.js（3D 钢琴相关资源）；主交互逻辑见 `musicmol-piano.js` |
| 运维脚本 | Bash：`start_flask.sh`、`setup_ubuntu.sh`；`deploy/` systemd 用户单元 |

### 3.3 目录与模块职责

| 路径 | 职责 |
|------|------|
| `MusicMol_0322/app.py` | 唯一后端入口：路由、推理调度、队列、外发、管理快照 |
| `MusicMol_0322/musicmol-piano.js` | 钢琴 UI、模式同步、自动演奏、轮询 `molecule_music_ui_pending` / `midi_exchange` |
| `音乐到分子/` | 模型配置、编译扩展、Notebook 批处理示例 |
| `分子到音乐/` | 分子→音乐 Python 包（供服务端集成） |
| `deploy/` | 登录自启动 MusicMol（systemd user） |

### 3.4 部署拓扑与端口约定

| 端口/角色 | 说明 |
|-----------|------|
| **5020** | MusicMol Flask 默认端口（`MUSICMOL_LISTEN_PORT`），API 与静态页同源时可一并访问 |
| **8081 / 8766** | 常见「仅托管 HTML 的映射端」；前端会将 API 根指回 **同主机 5020**（见 `FRONTEND_API_IN_USE.md`） |
| **8082** | 外部展陈接收服务（本仓库不含实现）；外发基址 `MUSICMOL_OUTBOUND_BASE` |

### 3.5 关键环境变量

| 变量 | 作用 |
|------|------|
| `MUSICMOL_LISTEN_HOST` / `MUSICMOL_LISTEN_PORT` | 绑定地址与端口 |
| `MUSICMOL_INFERENCE_DEVICE` | `auto` \| `cpu` \| `cuda` |
| `MUSICMOL_OUTBOUND_BASE` | 外发 JSON 的基址（无尾斜杠） |
| `MUSICMOL_OUTBOUND_ENABLE` | `0` 关闭外发 |
| `MUSICMOL_MAPPING_POLL_DISABLE` 等 | 映射 API 访问日志（见 `start_flask.sh`） |
| `MUSICMOL_ADMIN_TOKEN` | 管理快照接口令牌（若启用 admin） |

---

## 4. 业务逻辑

### 4.1 模式：音乐生成分子（music_to_molecule）

- 用户在钢琴上演奏，前端累积 MIDI 片段；
- 点击「生成分子」→ `POST /api/music_to_molecule` 或上传 MIDI → `/api/music_to_molecule_midi`；
- 服务端推理返回 `best_smiles`；可按约定外发至 8082；
- 成功后顶栏可展示 SMILES 与「重新弹奏」；**大屏 POST 切换模式后**，前端轮询到 `molecule_to_music` 时会自动重置本地 UI 状态（无需强制手工点「重新弹奏」）。

### 4.2 模式：分子生成音乐（molecule_to_music）

- 大屏或其它系统 `POST /api/piano_interaction_mode` 置为 `molecule_to_music`；
- 提交 SMILES：`POST /api/molecule_submit` 或带 `smiles` 的 `POST /api/midi_exchange` → 服务端生成 MIDI 并入队，并可将 piano 模式同步为分子→音乐；
- 钢琴页 **优先轮询** `GET /api/molecule_music_ui_pending`，收到 `midi_events` 后自动演奏（用户键盘在该模式下按产品设计锁定为展示态）；
- 演奏结束后 `POST /api/molecule_music_ui_dismiss` 清队列（由前端自动或手动触发）。

### 4.3 外部裸 MIDI（midi_exchange，无 SMILES）

- `POST /api/midi_exchange` 仅 events → `GET /api/midi_exchange/ui_pending` 待钢琴确认；
- 在 **molecule_to_music** 模式下，前端策略可不消费此类 pending（避免与 SMILES 管线冲突），具体见前端实现与 `FRONTEND_API_IN_USE.md`。

### 4.4 外发链路（8082）

- 后端：`POST {BASE}/__push/smiles`、`POST {BASE}/__push/midi` 等；
- 前端点歌：`fetch` 至 `{页面主机}:8082/__push/glass_session`（跨域由对端配置）；
- **边界**：回执字段、校验逻辑归属外部服务。

### 4.5 数据流（简化）

**音乐 → 分子**：演奏事件 → Flask → Transformer → SMILES →（可选）8082  
**分子 → 音乐**：SMILES → Flask → MIDI 事件队列 → 钢琴轮询 → Web Audio 演奏 → dismiss

---

## 5. 部署与运维

### 5.1 前置条件

- Linux x86_64，Python 3.10，conda 推荐；
- GPU 可选（CUDA 与 PyTorch 版本需匹配）；
- 权重文件置于 `音乐到分子/` 目录（文件名与路径以实际推理代码为准）；
- 防火墙/NAT：按需放行 **5020**（及 8082 若同机部署接收端）。

### 5.2 安装步骤（摘要）

1. `conda create -n musicmol python=3.10`  
2. `conda install -c conda-forge rdkit`  
3. 安装 PyTorch 与 `pip install -r MusicMol_0322/requirements.txt`（或执行 `setup_ubuntu.sh` 并根据机器修改 conda 路径）  
4. 复制 `model_last(2).pt` 等到 `音乐到分子/`  
5. `./start_flask.sh` 启动

### 5.3 开机自启（可选）

```bash
./deploy/install-user-autostart.sh   # 生成 systemd user 单元
# 卸载：./deploy/uninstall-user-autostart.sh
```

### 5.4 日志与诊断

| 位置 | 内容 |
|------|------|
| `MusicMol_0322/logs/mapping_api.log` | 关键 API 访问 JSONL |
| `MusicMol_0322/logs/mapping_poll_state.log` | 钢琴模式轮询快照 |
| 控制台 / systemd journal | Flask 运行日志 |

### 5.5 健康检查

- `GET http://<host>:5020/api/status_lite` → `ok`、`music_to_molecule`、`molecule_to_music` 就绪标志  
- `GET /api/piano_interaction_mode` → 当前大屏同步模式  

### 5.6 容量与安全建议

- 单 worker；重启丢失内存队列；
- 勿将开发服务器直接暴露公网；前置 Nginx + HTTPS；
- 配置 `MUSICMOL_ADMIN_TOKEN` 并限制 `/api/admin/*` 访问源 IP；
- 定期备份权重与配置文件。

---

## 6. 操作说明

### 6.1 运维人员

| 操作 | 命令/步骤 |
|------|-----------|
| 启动 | `./start_flask.sh` |
| 停止 | 终端 Ctrl+C 或 `fuser -k 5020/tcp`（慎用） |
| 改端口 | `export MUSICMOL_LISTEN_PORT=xxxx` 后启动 |
| 仅本机监听 | `export MUSICMOL_LISTEN_HOST=127.0.0.1` |
| 局域网访问 | 保持 `0.0.0.0`，防火墙放行 TCP 5020 |
| NAT 映射 | 路由器转发至服务器当前局域网 IP 的 5020 |

### 6.2 联调/大屏

1. 确保钢琴浏览器能访问 **5020**（映射页在 8081/8766 时 API 仍指向同主机 5020）。  
2. 切换模式：`POST /api/piano_interaction_mode`，Body：`{"mode":"music_to_molecule"}` 或 `{"mode":"molecule_to_music"}`。  
3. 下发分子音乐：`POST /api/molecule_submit`，Body 含 `smiles`、`bpm`（可选）、`auto_play`（按接口约定）。  
4. 验证钢琴页自动拉取 pending 并开始演奏。

### 6.3 终端用户（钢琴页）

- **音乐生成分子**：演奏 → 「生成分子」→ 查看结果横幅；大屏切换模式后本地状态会自动对齐。  
- **分子生成音乐**：由大屏驱动；本地以状态栏展示当前模式；自动演奏时不要依赖手动弹奏。  
- **音频**：首次需点击页面以解锁 AudioContext（浏览器策略）。

---

## 7. 验收清单

以下为建议性验收项，可按甲方合同裁剪。

### 7.1 环境与部署

- [ ] Python 3.10 与依赖安装完成，无导入错误  
- [ ] `GET /api/status_lite` 返回 `ok: true`  
- [ ] 权重文件就位，`music_to_molecule` 就绪为 true（若 GPU/CPU 满足）  
- [ ] `molecule_to_music` 就绪为 true（`分子到音乐` 目录可用）  
- [ ] `start_flask.sh` 可重复启动，端口无冲突  

### 7.2 功能：音乐 → 分子

- [ ] 钢琴演奏后推理返回合法 SMILES（或错误提示可读）  
- [ ] （可选）`push_outbound_smiles` 为真时 8082 收到推送（需对端配合）  

### 7.3 功能：分子 → 音乐

- [ ] `POST` 切换 `molecule_to_music` 后钢琴状态栏同步  
- [ ] `molecule_submit` 后钢琴轮询到 MIDI 并自动演奏  
- [ ] 演奏完成后 pending 清除或可再次下发  

### 7.4 联调与稳定性

- [ ] 映射端口场景下静态资源与 API 指向正确（无 404 循环指向错误端口）  
- [ ] 模式切换后不因「重新弹奏」横幅阻塞 pending（回归场景）  
- [ ] 长时间运行无显存泄漏（GPU 场景抽样观察）  

### 7.5 文档与交付物

- [ ] README、本交付说明书、API 文档路径可追溯  
- [ ] 已知限制（内存队列、`.so` 平台）已告知甲方  

---

## 8. 术语表

| 术语 | 解释 |
|------|------|
| **SMILES** | 用 ASCII 字符串描述分子结构的线性表示 |
| **SELFIES** | 分子结构的另一种字符串表示，常用于生成模型 |
| **MIDI** | 数字音乐事件协议；本项目中多为 note/start/duration |
| **MusicMol** | 本仓库 Web 服务与演示应用统称 |
| **music_to_molecule** | 业务/接口模式：音乐 → 分子 |
| **molecule_to_music** | 业务/接口模式：分子 → 音乐 |
| **pending / 队列** | 服务端内存中的「待钢琴消费」状态（非持久化） |
| **外发 / Outbound** | MusicMol 主动 POST 到 `MUSICMOL_OUTBOUND_BASE`（常为 8082） |
| **映射端** | 仅反向代理或静态托管钢琴 HTML 的端口（如 8081、8766）；API 仍回源 5020 |
| **RDKit** | 开源化学信息学工具包 |
| **QED** | 药物相似度定量估算，用于候选分子排序 |
| **Beam Search** | 解码时保留多条候选路径的搜索策略 |
| **Flask** | Python 轻量 Web 框架 |
| **API_BASE** | 前端拼接 REST 请求的根 URL（同源 5020 或显式查询参数覆盖） |

---

## 9. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05 | 首版：架构、业务、部署、验收、术语 |

---

**附录**：详细接口字段与前端行为以 `MusicMol_0322/docs/FRONTEND_API_IN_USE.md`、`API_INTEGRATION.md` 及 `MIDI_EXCHANGE_PROTOCOL_V1.md` 为准。
