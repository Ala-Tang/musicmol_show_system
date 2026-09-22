# MusicMol 本项目集成接口说明

## 概述

本文档描述 PAINOJS 展陈项目与 MusicMol 本项目（分子生成音乐模式）的交互接口。

## 交互流程

### 第二种方式：分子生成音乐（AI 计算音乐）

```
PAINOJS（展陈端）                          MusicMol（本项目）
    │                                          │
    │  1. 发送 SMILES                          │
    │ ───────────POST /api/molecule_submit────>│
    │     {smiles, bpm, auto_play=true}        │
    │                                          │
    │  2. AI 计算音乐                          │
    │     （使用 /home/user/文档/beifen/pinao8/分子到音乐）
    │                                          │
    │  3. 计算成功，返回成功状态               │
    │ <──────────{ok: true, seq, has_midi}─────│
    │                                          │
    │  4. 开始自动演奏                         │
    │     （前端轮询 /api/molecule_music_ui_pending）
    │                                          │
    │  5. 发送开始演奏状态                     │
    │ <──────────POST /__push/manual_molecule_music_phase
    │     {phase: "playing", session_id}       │
    │                                          │
    │  6. 演奏中...                            │
    │                                          │
    │  7. 发送结束演奏状态                     │
    │ <──────────POST /__push/manual_molecule_music_phase
    │     {phase: "finished", session_id}      │
    │                                          │
```

## 接口详情

### 1. 发送 SMILES 触发 AI 计算

**请求**
```http
POST http://{MUSICMOL_HOST}:5020/api/molecule_submit
Content-Type: application/json

{
  "smiles": "CC(=O)Oc1ccccc1C(=O)O",
  "bpm": 100,
  "auto_play": true,
  "session_id": "a8caec09-7bb3-42fc-bc92-469195cb0cda"
}
```

**参数说明**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| smiles | string | 是 | SMILES 分子字符串 |
| bpm | int | 否 | 节拍速度，默认 100 |
| auto_play | bool | 否 | 自动演奏模式，默认 false |
| session_id | string | 否 | 会话 ID，用于状态跟踪 |

**响应**
```json
{
  "ok": true,
  "seq": 1,
  "has_midi": true,
  "midi_event_count": 19,
  "auto_play": true,
  "session_id": "a8caec09-7bb3-42fc-bc92-469195cb0cda"
}
```

### 2. 接收开始演奏状态

MusicMol 开始自动演奏时，会向 PAINOJS 的 8082 服务发送状态。

**接收接口**
```http
POST http://{PAINOJS_HOST}:8082/__push/manual_molecule_music_phase
Content-Type: application/json

{
  "phase": "playing",
  "session_id": "a8caec09-7bb3-42fc-bc92-469195cb0cda",
  "ts_ms": 1777923000000
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| phase | string | 阶段："playing" 表示开始演奏 |
| session_id | string | 会话 ID，与 molecule_submit 对应 |
| ts_ms | int64 | 时间戳（毫秒） |

### 3. 接收结束演奏状态

MusicMol 演奏结束时，会向 PAINOJS 的 8082 服务发送状态。

**接收接口**
```http
POST http://{PAINOJS_HOST}:8082/__push/manual_molecule_music_phase
Content-Type: application/json

{
  "phase": "finished",
  "session_id": "a8caec09-7bb3-42fc-bc92-469195cb0cda",
  "ts_ms": 1777923100000
}
```

### 4. 查询演奏进度（可选）

PAINOJS 可以查询手动生成分子音乐的进度。

**请求**
```http
GET http://{PAINOJS_HOST}:8082/api/manual_molecule_music_ui_status?session_id=a8caec09-7bb3-42fc-bc92-469195cb0cda
```

**响应**
```json
{
  "phase": "playing",
  "session_id": "a8caec09-7bb3-42fc-bc92-469195cb0cda",
  "ts_ms": 1777923000000,
  "smiles": "CC(=O)Oc1ccccc1C(=O)O"
}
```

## 状态流转

```
molecule_submit
      │
      ▼
  ┌─────────┐
  │ pending │  （等待计算）
  └────┬────┘
       │
       ▼
  ┌─────────┐
  │ playing │  （开始演奏）
  └────┬────┘
       │
       ▼
  ┌─────────┐
  │finished │  （演奏结束）
  └─────────┘
```

## 错误处理

### MusicMol 计算失败

```json
{
  "ok": false,
  "error": "RDKit 无法解析该 SMILES"
}
```

### MusicMol 生成 MIDI 失败

```json
{
  "ok": true,
  "seq": 1,
  "has_midi": false,
  "midi_event_count": 0
}
```

## 配置说明

### MusicMol 外发配置

MusicMol 需要配置外发目标为 PAINOJS 的 8082 服务：

```bash
export MUSICMOL_OUTBOUND_BASE=http://{PAINOJS_HOST}:8082
```

### PAINOJS 接收配置

PAINOJS 的 `ui_poll_receiver` 服务需要运行在 8082 端口：

```bash
python3 server/ui_poll_receiver/app.py
# 默认监听 0.0.0.0:8082
```

## 示例代码

### PAINOJS 发送 SMILES

```javascript
async function sendSmilesToMusicMol(smiles, bpm = 100) {
  const sessionId = generateSessionId();
  
  const response = await fetch('http://10.70.160.26:5020/api/molecule_submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      smiles: smiles,
      bpm: bpm,
      auto_play: true,
      session_id: sessionId
    })
  });
  
  const result = await response.json();
  
  if (result.ok && result.has_midi) {
    console.log('AI 计算成功，开始自动演奏');
    // 监听演奏状态...
  } else {
    console.error('计算失败:', result.error);
  }
  
  return result;
}
```

### PAINOJS 接收演奏状态

```javascript
// 轮询查询进度
async function checkMusicStatus(sessionId) {
  const response = await fetch(
    `http://127.0.0.1:8082/api/manual_molecule_music_ui_status?session_id=${sessionId}`
  );
  const status = await response.json();
  
  if (status.phase === 'playing') {
    showPlayingStatus(status.smiles);
  } else if (status.phase === 'finished') {
    showFinishedStatus(status.smiles);
  }
  
  return status;
}
```

## 注意事项

1. **session_id 一致性**：发送和接收的 session_id 必须一致，用于状态跟踪
2. **超时处理**：AI 计算可能需要时间，建议设置超时时间
3. **错误重试**：计算失败时可以重试或提示用户
4. **状态同步**：PAINOJS 需要维护本地状态，与 MusicMol 保持同步

## 相关文件

- MusicMol 本项目：`/home/user/文档/beifen/pinao8/MusicMol_0322/app.py`
- 分子到音乐模块：`/home/user/文档/beifen/pinao8/分子到音乐/`
- PAINOJS 接收端：`/home/user/文档/beifen/painojs/server/ui_poll_receiver/app.py`

---

## 新接口：播放示例 MIDI 文件

### 接口说明

接收 MIDI 文件名或歌曲键名，自动解析并放入播放队列。前端轮询 `/api/midi_exchange/ui_pending` 后自动演奏。

### 请求

```http
POST http://{MUSICMOL_HOST}:5020/api/play_example_midi
Content-Type: application/json

{
  "filename": "03_生日快乐_Happy_Birthday.mid",
  "bpm": 100
}
```

或

```http
POST http://{MUSICMOL_HOST}:5020/api/play_example_midi
Content-Type: application/json

{
  "song_key": "生日快乐_Happy_Birthday",
  "bpm": 100
}
```

### 参数说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filename | string | 否 | 完整 MIDI 文件名（如 "03_生日快乐_Happy_Birthday.mid"） |
| song_key | string | 否 | 歌曲键名（如 "生日快乐_Happy_Birthday"） |
| bpm | int | 否 | 节拍速度，默认 100，范围 40-240 |

**注意**：`filename` 和 `song_key` 至少提供一个。同时提供时优先使用 `filename`。

### 响应

**成功**
```json
{
  "ok": true,
  "event_count": 25,
  "bpm": 100,
  "filename": "03_生日快乐_Happy_Birthday.mid",
  "song_key": "生日快乐_Happy_Birthday",
  "total_duration_ms": 13636
}
```

**失败**
```json
{
  "ok": false,
  "error": "未找到 MIDI 文件: xxx"
}
```

### 支持的 MIDI 文件

位于 `/home/user/文档/beifen/pinao8/示例钢琴MIDI合集/` 目录：

| 文件名 | song_key |
|--------|----------|
| 00_浙大校歌.mid | 浙大校歌 |
| 01_小星星_Twinkle_Twinkle.mid | 小星星_Twinkle_Twinkle |
| 02_两只老虎_Two_Tigers.mid | 两只老虎_Two_Tigers |
| 03_生日快乐_Happy_Birthday.mid | 生日快乐_Happy_Birthday |
| 04_玛丽有只小羊羔_Mary_Had_a_Little_Lamb.mid | 玛丽有只小羊羔_Mary_Had_a_Little_Lamb |
| 05_划船歌_Row_Row_Row_Your_Boat.mid | 划船歌_Row_Row_Row_Your_Boat |
| 06_伦敦桥_London_Bridge.mid | 伦敦桥_London_Bridge |
| 07_小蜜蜂.mid | 小蜜蜂 |
| 08_铃儿响叮当_Jingle_Bells.mid | 铃儿响叮当_Jingle_Bells |

### 工作流程

```
PAINOJS（展陈端）                          MusicMol（本项目）
    │                                          │
    │  1. 发送 MIDI 文件名                     │
    │ ───────────POST /api/play_example_midi──>│
    │     {filename 或 song_key, bpm}          │
    │                                          │
    │  2. 解析 MIDI 文件                       │
    │     （使用 mido 库读取 .mid 文件）       │
    │                                          │
    │  3. 存入播放队列                         │
    │     （复用 midi_exchange 机制）          │
    │                                          │
    │  4. 返回成功状态                         │
    │ <──────────{ok: true, event_count}───────│
    │                                          │
    │  5. 前端轮询检测到待播放数据               │
    │     （每 2 秒轮询 /api/midi_exchange/ui_pending）
    │                                          │
    │  6. 自动演奏                             │
    │     （调用 enterAutoPlayFromMidiEvents）  │
    │                                          │
    │  7. 演奏结束，清除队列                   │
    │     （调用 /api/midi_exchange/ui_dismiss）│
    │                                          │
```

### 匹配规则

文件名匹配优先级：
1. 完整文件名匹配（如 "03_生日快乐_Happy_Birthday.mid"）
2. 自动加 `.mid` 后缀匹配
3. song_key 精确匹配（去掉序号前缀后的名称）
4. 模糊匹配（仅当结果唯一时接受）

