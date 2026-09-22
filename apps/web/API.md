# MusicMol 数据接口文档

> 版本：v2.0  
> 服务地址：`http://127.0.0.1:5020`  
> 所有接口均支持 CORS，请求与响应格式为 `application/json`。

---

## 接口总览

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 分子 → 音乐 | POST | `/api/molecule_to_music` | 输入 SMILES，返回 MIDI 事件数组 |
| 音乐 → 分子 | POST | `/api/music_to_molecule` | 输入 MIDI 事件片段，返回最佳 SMILES |
| PainoJS 提交 SMILES | POST | `/api/molecule_submit` | 与前端 `musicMolApi.postMoleculeSubmit` 一致；**非** `molecule_to_music` 路径 |
| PainoJS 提交 MIDI | POST | `/api/midi_exchange` | 与前端 `postMidiExchange` 一致；body 含 `events` / `bpm` / `session_id` 等 |

> **部署注意**：若 5020 上只实现了 v2 文档前两行路径，而未注册 **`/api/molecule_submit`** 与 **`/api/midi_exchange`**，浏览器会收到 **404**，映射端表现为「收不到 PainoJS 数据」。本仓库 `musicmol_vs/flask_api/app_v2.py` 已包含上述两路由，并将最近一次请求写入同目录 **`latest_molecule_submit.json`**、**`latest_midi_exchange.json`** 供展陈/中控轮询。

---

## 1. 分子 → 音乐

### 请求

```http
POST /api/molecule_to_music
Content-Type: application/json
```

```json
{
  "smiles": "CCO",
  "bpm": 100
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `smiles` | string | 是 | 化学分子 SMILES 字符串 |
| `bpm` | int | 否 | 演奏速度，默认 100，范围 40–240 |

### 成功响应（200）

```json
{
  "ok": true,
  "midi_events": [
    {
      "time": 480,
      "type": "noteOn",
      "note": 60,
      "duration": 120,
      "velocity": 90
    },
    {
      "time": 960,
      "type": "noteOn",
      "note": 64,
      "duration": 600,
      "velocity": 90
    }
  ],
  "meta": {
    "smiles": "CCO",
    "canonical_smiles": "CCO",
    "bpm": 100,
    "event_count": 2,
    "num_atoms": 3,
    "num_heavy_atoms": 3
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `midi_events` | array | MIDI 事件数组，按 `time` 升序排列 |
| `midi_events[].time` | int | 事件触发时间，单位 ms（相对首事件） |
| `midi_events[].type` | string | 固定为 `"noteOn"` |
| `midi_events[].note` | int | MIDI 音符编号（0–127） |
| `midi_events[].duration` | int | 音符持续时长，单位 ms |
| `midi_events[].velocity` | int | 力度（0–127） |
| `meta` | object | 元数据：原始/规范 SMILES、BPM、事件数、原子数 |

### 错误响应（400 / 500）

```json
{
  "ok": false,
  "error": "RDKit 无法解析该 SMILES"
}
```

常见错误：
- `SMILES 为空` — 请求体缺少 `smiles` 字段或为空字符串
- `RDKit 无法解析该 SMILES` — SMILES 格式非法
- `MIDI 事件生成失败` — 后端 Cython 模块解析或转换异常

---

## 2. 音乐 → 分子

### 请求

```http
POST /api/music_to_molecule
Content-Type: application/json
```

```json
{
  "events": [
    { "note": 60, "start": 0, "duration": 400 },
    { "note": 64, "start": 500, "duration": 400 }
  ],
  "bpm": 100
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `events` | array | 是 | MIDI 事件片段，每个元素为一个音符 |
| `events[].note` | int | 是 | MIDI 音符编号（0–127） |
| `events[].start` | int | 是 | 音符开始时间，单位 ms（相对基准） |
| `events[].duration` | int | 是 | 音符持续时长，单位 ms |
| `bpm` | int | 否 | 演奏速度，默认 100，范围 40–240 |

### 成功响应（200）

```json
{
  "ok": true,
  "best_smiles": "CCO",
  "meta": {
    "qed": 0.8248,
    "canonical_smiles": "CCO",
    "event_count": 2,
    "bpm": 100,
    "inference_time_ms": null
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `best_smiles` | string | 推理得到的最佳 SMILES（经 RDKit 规范化） |
| `meta.qed` | float | 最佳候选的 QED 药物相似度评分（0–1） |
| `meta.canonical_smiles` | string | 规范化后的 SMILES |
| `meta.event_count` | int | 输入事件数量 |
| `meta.bpm` | int | 输入 BPM |

### 错误响应（400 / 500）

```json
{
  "ok": false,
  "error": "events 为空，无法推理"
}
```

常见错误：
- `events 为空，无法推理` — `events` 为空数组或未提供
- `未找到目录：音乐到分子` — 后端缺少 Transformer 模型目录
- `缺少 model_last.pt 或 model_last(2).pt` — 缺少模型权重文件
- `推理完成但未产出预测结果` — 模型推理异常

---

## 前端调用示例

### 分子 → 音乐

```javascript
const result = await fetch("http://127.0.0.1:5020/api/molecule_to_music", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ smiles: "CCO", bpm: 100 })
});
const data = await result.json();
// data.midi_events → 交给钢琴自动演奏
```

### 音乐 → 分子（实时片段）

```javascript
const events = [
  { note: 60, start: 0, duration: 400 },
  { note: 64, start: 500, duration: 400 }
];
const result = await fetch("http://127.0.0.1:5020/api/music_to_molecule", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ events, bpm: 100 })
});
const data = await result.json();
// data.best_smiles → 显示分子结果
```

---

## 实时演奏流程说明

### 钢琴前端 → 后端（音乐 → 分子）

1. 用户在钢琴上弹奏，前端记录 `liveEvents: [{note, start, duration}]`
2. 当积累到一定数量的事件（如 8+ 个）或用户点击"生成分子"按钮时
3. 前端调用 `POST /api/music_to_molecule`，发送当前事件片段
4. 后端：
   - 将事件写入临时 MIDI 文件
   - 调用 Transformer 模型（`音乐到分子/*.so`）进行 beam search + QED 选优
   - 返回最佳 SMILES
5. 前端显示 `best_smiles`，并可选调用 `POST /api/molecule_to_music` 将结果再转回 MIDI 演奏

### 外部程序 → 后端（分子 → 音乐）

1. 外部程序发送 `POST /api/molecule_to_music` 携带 SMILES
2. 后端：
   - 用 RDKit 验证 SMILES
   - 调用 `分子到音乐` Cython 模块生成 MIDI 文件
   - 用 `mido` 解析为事件数组
3. 返回 `midi_events`
4. 前端（或外部程序）按 `time` 字段调度音频与视觉动效

---

## 模型与依赖

| 方向 | 技术栈 | 说明 |
|------|--------|------|
| 分子 → 音乐 | `smile_to_midi_v10` (Cython) + `mido` | 规则引擎，将原子/键映射为音符/节奏 |
| 音乐 → 分子 | PyTorch Transformer + Beam Search + QED | 深度 seq2seq，编码器输入 MIDI token，解码器输出 SELFIES |
| SMILES 验证 | RDKit | `Chem.MolFromSmiles` 解析与规范化 |

---

## 注意事项

1. **音频解锁**：浏览器 Web Audio API 需要用户手势（点击按钮）后才能自动播放。首次演奏前需点击一次页面内的按钮。
2. **GPU 预热**：Flask 启动时会自动执行一次空推理预热 CUDA。首次真实请求约需 2–3 秒（RTX PRO 5000），后续请求约 2 秒。
3. **事件时间**：`midi_events` 中的 `time` 为相对时间（首事件从 0 开始）。前端调度时应加上当前时间戳作为基准。
4. **实时片段**：`music_to_molecule` 支持随时发送最新片段，后端不做状态积累，每次请求独立推理。
