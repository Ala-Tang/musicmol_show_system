# 钢琴端发送协议 v1（MusicMol MIDI Exchange）

本文定义外部钢琴/音乐交换端向本项目发送 MIDI 事件的统一协议（v1）。

目标：
- 先稳定完成“可接收、可确认、可回放”的数据闭环；
- 为后续点云动态联动预留足够字段；
- 保证旧客户端在字段扩展后仍可用。

---

## 1. 接口信息

- 方法：`POST`
- 路径：`/api/midi_exchange`
- Content-Type：`application/json`
- 默认本地地址（示例）：`http://127.0.0.1:5001/api/midi_exchange`

健康检查与调试：
- `GET /health`
- `GET /api/midi_exchange/latest`
- `GET /api/midi_exchange/events?limit=20`

---

## 2. 顶层请求体（Envelope）

```json
{
  "protocol": "midi-exchange-v1",
  "source": "external_piano",
  "session_id": "room-001",
  "sequence": 1024,
  "sent_at": 1710000000123,
  "midi": {
    "type": "note_on",
    "note": 60,
    "velocity": 96,
    "channel": 0,
    "timestamp": 1710000000123
  },
  "meta": {
    "device_id": "piano-a1",
    "performer": "demo-user"
  }
}
```

### 2.1 顶层字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 否 | 协议版本标识，建议固定为 `midi-exchange-v1` |
| `source` | string | 否 | 发送端标识，如 `external_piano` / `exchange_bridge` |
| `session_id` | string | 否 | 会话 ID，用于一场演奏或一个房间的归并 |
| `sequence` | number | 否 | 发送端递增序号，便于检测丢包/乱序 |
| `sent_at` | number | 否 | 发送端时间戳（毫秒） |
| `midi` | object/array/any | **是** | MIDI 负载（本协议建议 object） |
| `meta` | object | 否 | 扩展信息，服务端透传存储 |

> 当前后端仅强制要求 `midi` 存在，其余字段建议按本协议提供。

---

## 3. `midi` 字段规范（v1 推荐）

建议 `midi` 使用对象，并按下表定义：

| 字段 | 类型 | 必填 | 约束/建议 |
|---|---|---|---|
| `type` | string | 是 | `note_on` / `note_off` / `control_change` / `program_change` / `pitch_bend` |
| `note` | number | 条件必填 | `note_on` / `note_off` 时必填，范围 `0-127` |
| `velocity` | number | 条件必填 | `note_on` 时建议必填，范围 `0-127` |
| `channel` | number | 否 | MIDI 通道，范围 `0-15`，默认 `0` |
| `timestamp` | number | 否 | 事件时间戳（毫秒） |
| `cc` | number | 条件必填 | `control_change` 时必填，范围 `0-127` |
| `value` | number | 条件必填 | `control_change` 时必填，范围 `0-127` |
| `program` | number | 条件必填 | `program_change` 时必填，范围 `0-127` |
| `bend` | number | 条件必填 | `pitch_bend` 时必填，建议 `-8192~8191` |

---

## 4. 事件示例

### 4.1 Note On

```json
{
  "protocol": "midi-exchange-v1",
  "source": "external_piano",
  "session_id": "room-001",
  "sequence": 1,
  "midi": {
    "type": "note_on",
    "note": 60,
    "velocity": 100,
    "channel": 0,
    "timestamp": 1710000000123
  }
}
```

### 4.2 Note Off

```json
{
  "protocol": "midi-exchange-v1",
  "source": "external_piano",
  "session_id": "room-001",
  "sequence": 2,
  "midi": {
    "type": "note_off",
    "note": 60,
    "velocity": 0,
    "channel": 0,
    "timestamp": 1710000000456
  }
}
```

### 4.3 Control Change（如踏板）

```json
{
  "protocol": "midi-exchange-v1",
  "source": "external_piano",
  "session_id": "room-001",
  "sequence": 3,
  "midi": {
    "type": "control_change",
    "cc": 64,
    "value": 127,
    "channel": 0,
    "timestamp": 1710000000789
  }
}
```

---

## 5. 响应规范（当前实现）

成功示例（HTTP 200）：

```json
{
  "ok": true,
  "message": "midi_received",
  "event_id": 12,
  "buffered": 45
}
```

失败示例（HTTP 400）：

```json
{
  "ok": false,
  "error": "missing_midi"
}
```

---

## 6. 兼容与演进规则

- **向后兼容**：新增字段必须是可选字段，不改变既有字段语义。
- **协议升级**：若有不兼容变更，升级 `protocol`（如 `midi-exchange-v2`）并保留 v1 一段时间。
- **容错建议**：
  - 接收端忽略未知字段；
  - `midi` 若非 object（如数组）仍可接收，但不保证后续点云映射可用。

---

## 7. 发送端建议（实操）

- 发送频率高时，优先发送事件流（逐条）而非超大批量数组。
- 保持 `sequence` 递增，便于排查丢包。
- 时间戳统一毫秒（`Date.now()`）。
- 若跨进程/跨机器，建议在 `source + session_id + sequence` 维度保证幂等。

---

## 8. 快速测试

```bash
curl -X POST "http://127.0.0.1:5001/api/midi_exchange" \
  -H "Content-Type: application/json" \
  -d "{\"protocol\":\"midi-exchange-v1\",\"source\":\"external_piano\",\"session_id\":\"room-001\",\"sequence\":1,\"midi\":{\"type\":\"note_on\",\"note\":60,\"velocity\":100,\"channel\":0,\"timestamp\":1710000000123}}"
```

