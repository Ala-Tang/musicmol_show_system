# 本地 API 接入说明

本文说明如何在**其它本地项目**中连接本仓库（MusicMol）的 Flask 服务，发送 SMILES 等信息。

## 前提

1. 在本项目根目录启动服务：

   ```bash
   python app.py
   ```

2. 默认监听地址：**`http://127.0.0.1:5020`**（端口在 `app.py` 的 `app.run` 中配置）。

3. 调用方与本服务需网络可达：同一台机器上使用 `127.0.0.1` 即可。

## 基础地址

```text
http://127.0.0.1:5020
```

建议在其它项目中用环境变量或配置文件保存该基址，例如 `MUSICMOL_API_BASE=http://127.0.0.1:5020`。

---

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 探活，确认服务已启动 |
| `POST` | `/api/molecule_play` | 提交 SMILES，服务端用 RDKit 校验并返回解析与演奏提示（**不返回 MIDI 事件列表**） |
| `POST` | `/render_svg` | 提交 SMILES，返回 2D 分子图（base64 PNG）与 3D MOL Block（与「演奏调试」用途不同） |

---

## `GET /health`

用于健康检查。

**响应示例：**

```json
{
  "ok": true,
  "service": "musicmol",
  "port_hint": 5020
}
```

---

## `POST /api/molecule_play`

用于向本项目发送 SMILES，做服务端校验并返回结构化信息。

### 请求

- **URL：** `http://127.0.0.1:5020/api/molecule_play`
- **Header：** `Content-Type: application/json`
- **Body（JSON）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `smiles` | string | 是 | SMILES 字符串 |
| `bpm` | integer | 否 | 节拍，默认 `100`，有效范围 **40–240**（超出会被截断到该范围） |

**请求示例：**

```json
{
  "smiles": "CCO",
  "bpm": 100
}
```

### 成功响应（HTTP 200）

```json
{
  "ok": true,
  "receive": {
    "content_type": "application/json",
    "body_bytes": 26
  },
  "parse": {
    "bpm": 100,
    "smiles_input": "CCO",
    "valid": true,
    "canonical_smiles": "CCO",
    "num_atoms": 3,
    "num_heavy_atoms": 3,
    "message": "服务端解析成功；MIDI 由前端 generateScoreFromSmiles 生成"
  },
  "play": {
    "smiles": "CCO",
    "bpm": 100,
    "engine": "client_smile_to_score_v4"
  }
}
```

### 失败响应（HTTP 400）

常见原因：SMILES 为空、或 RDKit 无法解析。

```json
{
  "ok": false,
  "receive": { "content_type": "...", "body_bytes": 0 },
  "parse": {
    "bpm": 100,
    "smiles_input": "",
    "valid": false,
    "error": "SMILES 为空"
  }
}
```

或：

```json
{
  "ok": false,
  "parse": {
    "valid": false,
    "error": "RDKit 无法解析该 SMILES"
  }
}
```

（字段以实际返回为准。）

---

## `POST /render_svg`（简要）

用于根据 SMILES 生成图像与 3D 文本数据。

- **Body：** `{ "smiles": "..." }`
- **成功：** 返回 `mol_png`（base64）、`mol_block_3d` 等（详见 `app.py`）。

与 `/api/molecule_play` 的职责不同：前者偏展示与 3D 数据，后者偏「分子到音乐」链路的校验与元数据。

---

## 跨域（CORS）

本项目已对 Flask 应用启用 **`flask_cors` 的 `CORS(app)`**。

- **浏览器**中从另一个本地端口的前端页面使用 `fetch` / `axios` 访问 `http://127.0.0.1:5020`，一般可直接使用。
- **服务端**（Node、Python、桌面应用等）直接发 HTTP 请求，不涉及浏览器 CORS 限制。

---

## 调用示例

### cURL（Windows CMD）

```bat
curl -s -X POST "http://127.0.0.1:5020/api/molecule_play" ^
  -H "Content-Type: application/json" ^
  -d "{\"smiles\":\"CCO\",\"bpm\":100}"
```

### cURL（Linux / macOS）

```bash
curl -s -X POST "http://127.0.0.1:5020/api/molecule_play" \
  -H "Content-Type: application/json" \
  -d '{"smiles":"CCO","bpm":100}'
```

### JavaScript（`fetch`）

```javascript
const base = "http://127.0.0.1:5020";

const res = await fetch(`${base}/api/molecule_play`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ smiles: "CCO", bpm: 100 }),
});

const data = await res.json();
if (!res.ok) {
  console.error(data.parse?.error || res.statusText);
} else {
  console.log(data.parse, data.play);
}
```

### Python（`requests`）

```python
import requests

BASE = "http://127.0.0.1:5020"

r = requests.post(
    f"{BASE}/api/molecule_play",
    json={"smiles": "CCO", "bpm": 100},
    timeout=10,
)
r.raise_for_status()
print(r.json())
```

---

## 大屏前端（本仓库 painojs）样例菜单

- 用户在**左下角样例**中选中某一分子并进入**详情**时，浏览器会向 **`POST /api/molecule_submit`** 发送当前条目的 **`SMILES`**（及默认 **`bpm`**，与 `molecule_play` 请求体约定一致时可复用）。
- 基址默认 **`http://127.0.0.1:5020`**，由 `js/paino/config.js` 中 **`MUSICMOL_API_BASE`** 提供；可在页面脚本加载前设置 **`globalThis.MUSICMOL_API_BASE`** 覆盖，或设为空字符串 **`''`** 以关闭该请求。
- 实现位置：`js/paino/api/musicMolApi.js`（请求体）、`js/paino/ui/sampleDrugGallery.js`（在 `finalizeDetailFromPick` 中触发）、`js/paino/app.js`（注入配置）。

---

## 与「钢琴发声」的关系

- **`/api/molecule_play`**：适合外部项目做 **SMILES 校验**、读取 **`canonical_smiles`**、原子数等元数据，以及与本项目约定的 **`play.smiles` / `play.bpm`**。
- **MIDI 事件序列** 当前由浏览器内的 **`smile_to_score_v4.js`**（`generateScoreFromSmiles`）生成；本仓库页面下方的「接口模式调试」即在收到成功响应后，在前端生成事件并调用 **`MusicMolPiano.playMidiEvents`**。
- 若外部项目需要 **纯服务端返回 MIDI JSON** 再在任意客户端播放，需要在后端扩展新接口或自行移植/调用等价逻辑（当前仓库未在 Flask 中返回完整 MIDI 数组）。

---

## 依赖与故障排查

- 依赖见项目根目录 **`requirements.txt`**（含 `flask`、`flask-cors`、`rdkit` 等）。
- 连接失败：确认 `python app.py` 已运行、防火墙未拦截本机 `5020` 端口、基址与端口一致。
- JSON 解析失败：检查 `Content-Type` 是否为 `application/json`，Body 是否为合法 JSON。
