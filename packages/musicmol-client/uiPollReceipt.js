/**
 * 8082 UI 轮询回执：record_id / ts_ingested_ms / receipt_digest 的校验与去重。
 * 算法与 `DOC/EXTERNAL_DATA_RECEIVER_API.md` 中「回执与校验」章节一致。
 */

/** 与 `server/ui_poll_receiver/app.py` 中允许的「接收时刻」最大偏斜一致（毫秒） */
export const UI_POLL_MAX_AGE_MS = 15 * 60 * 1000;
/** 允许客户端时钟略快于接收端 */
export const UI_POLL_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

/** 本仓库 8082 进程生成的 `record_id` 形态：UIP-{port}-{seq}-{hex8} */
export const UI_POLL_RECORD_ID_RE = /^UIP-\d{2,5}-\d+-[0-9a-f]{8}$/i;

/** 与 §3.3.5 一致：三者**同时**缺失才走兼容模式；仅缺其一或摘要不全则拒收 */
function receiptAllMissing(data) {
  const r = data?.record_id;
  const t = data?.ts_ingested_ms;
  const d = data?.receipt_digest;
  const noR = r == null || (typeof r === 'string' && r.trim() === '');
  const noT = t == null || t === '';
  const noD = d == null || (typeof d === 'string' && d.trim() === '');
  return noR && noT && noD;
}

/** 与 Python `json.dumps(..., sort_keys=True, separators=(',', ':'), ensure_ascii=False)` 对齐 */
export function pythonSortKeysJsonStringify(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((x) => pythonSortKeysJsonStringify(x)).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${pythonSortKeysJsonStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {number} x @param {number} n */
function rightrotate32(x, n) {
  x |= 0;
  return ((x >>> n) | (x << (32 - n))) | 0;
}

/** NIST SHA-256 轮常数 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * 与 `crypto.subtle.digest('SHA-256', …)` 同结果的十六进制小写串（输入为 UTF-8 字节）。
 * 用于非安全上下文（如 `http://10.x` 展陈机）：Chrome 不提供 `crypto.subtle`，否则会无法校验 digest。
 * @param {Uint8Array} bytes
 */
function sha256HexFromBytesPure(bytes) {
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const ml = bytes.length;
  const padLen = ((ml + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, 0, false);
  dv.setUint32(padLen - 4, ml * 8, false);
  const w = new Uint32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rightrotate32(w[t - 15], 7) ^ rightrotate32(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rightrotate32(w[t - 2], 17) ^ rightrotate32(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    for (let t = 0; t < 64; t++) {
      const S1 = rightrotate32(e, 6) ^ rightrotate32(e, 11) ^ rightrotate32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
      const S0 = rightrotate32(a, 2) ^ rightrotate32(a, 13) ^ rightrotate32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const od = new DataView(out.buffer);
  od.setUint32(0, h0, false);
  od.setUint32(4, h1, false);
  od.setUint32(8, h2, false);
  od.setUint32(12, h3, false);
  od.setUint32(16, h4, false);
  od.setUint32(20, h5, false);
  od.setUint32(24, h6, false);
  od.setUint32(28, h7, false);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256HexUtf8(text) {
  const enc = new TextEncoder();
  const buf = enc.encode(text);
  if (globalThis.crypto?.subtle?.digest) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      /* 与 Python 侧 digest 对齐时仍可用纯 JS 路径 */
    }
  }
  return sha256HexFromBytesPure(buf);
}

function nowMs() {
  return Date.now();
}

function parseIngestedMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** 8082 GET 轮询响应中的「本机发出时刻」，与 `ts_ingested_ms` 同源，用于消除浏览器与服务器时钟差。 */
function parseServerEmitMs(data) {
  if (!data || typeof data !== 'object') return null;
  const n = Number(data.server_emit_ms ?? data.serverEmitMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * @param {number} tsMs
 * @param {object} [data] GET 返回体；若含 `server_emit_ms` 则用其作「当前时刻」参与窗口判断
 */
function tsWindowOk(tsMs, data) {
  const ref = parseServerEmitMs(data);
  const now = ref != null ? ref : nowMs();
  if (tsMs > now + UI_POLL_MAX_FUTURE_SKEW_MS) return false;
  if (now - tsMs > UI_POLL_MAX_AGE_MS) return false;
  return true;
}

const recentSmilesIds = [];
const recentMidiIds = [];
const recentSessionIds = [];
const RING_CAP = 64;

function rememberId(ring, id) {
  ring.push(id);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
}

function isDuplicateId(ring, id) {
  return ring.includes(id);
}

/**
 * @param {'smiles'|'midi'|'session'} channel
 * @param {string} recordId
 * @returns {boolean} true 表示已登记（非重复）；false 表示重复 id
 */
export function registerUiPollRecordId(channel, recordId) {
  const id = String(recordId || '').trim();
  if (!id) return false;
  const ring =
    channel === 'midi' ? recentMidiIds : channel === 'session' ? recentSessionIds : recentSmilesIds;
  if (isDuplicateId(ring, id)) return false;
  rememberId(ring, id);
  return true;
}

export function clearUiPollRecordIdCache(channel) {
  const clearRing = (ring) => {
    ring.length = 0;
  };
  if (!channel) {
    clearRing(recentSmilesIds);
    clearRing(recentMidiIds);
    clearRing(recentSessionIds);
    return;
  }
  const c = String(channel).trim().toLowerCase();
  if (c === 'smiles') {
    clearRing(recentSmilesIds);
  } else if (c === 'midi') {
    clearRing(recentMidiIds);
  } else if (c === 'session') {
    clearRing(recentSessionIds);
  } else {
    clearRing(recentSmilesIds);
    clearRing(recentMidiIds);
    clearRing(recentSessionIds);
  }
}

export function smilesCoreFromEnvelope(data) {
  const sm = String(data?.smiles ?? data?.SMILES ?? data?.sm ?? '').trim();
  const o = { smiles: sm };
  if (data != null && data['编号'] !== undefined && data['编号'] !== null) {
    o['编号'] = data['编号'];
  }
  return o;
}

/** 与 `server/ui_poll_receiver/app.py` 入队时 MIDI 业务核一致：`int(bpm or 100)`、`json.loads(json.dumps(events))`、分子键顺序 */
export function midiCoreFromEnvelope(data) {
  const rawEv = data?.events ?? data?.midi_events;
  let events = [];
  if (Array.isArray(rawEv)) {
    try {
      events = JSON.parse(JSON.stringify(rawEv));
    } catch {
      events = [];
    }
  }
  const br = data?.bpm;
  let bpm = 100;
  if (br != null && br !== '') {
    const n = Number(br);
    bpm = Number.isFinite(n) ? Math.trunc(n) : 100;
  }
  if (bpm === 0) bpm = 100;
  const o = { bpm, events };
  if (data && data.molecule_id !== undefined && data.molecule_id !== null) {
    o.molecule_id = data.molecule_id;
  } else if (data && data.moleculeId !== undefined && data.moleculeId !== null) {
    o.molecule_id = data.moleculeId;
  } else if (data && data['编号'] !== undefined && data['编号'] !== null) {
    o.molecule_id = data['编号'];
  } else if (data && data['药物编号'] !== undefined && data['药物编号'] !== null) {
    o.molecule_id = data['药物编号'];
  }
  return o;
}

/**
 * @param {object} data GET 返回体
 * @returns {Promise<{ ok: boolean, reason?: string, smiles?: string, recordId?: string }>}
 */
export async function validateUiPollSmilesReceipt(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'empty' };
  const keys = Object.keys(data);
  if (keys.length === 0) return { ok: false, reason: 'empty_object' };

  const core = smilesCoreFromEnvelope(data);
  if (!core.smiles) return { ok: false, reason: 'missing_smiles' };

  const rid = data.record_id;
  const ts = data.ts_ingested_ms;
  const dig = data.receipt_digest;

  if (receiptAllMissing(data)) {
    /* §3.3.5：三字段同时缺失 → 兼容模式 */
    return { ok: true, smiles: core.smiles, recordId: '' };
  }

  if (typeof rid !== 'string' || !UI_POLL_RECORD_ID_RE.test(rid.trim())) {
    return { ok: false, reason: 'invalid_record_id' };
  }
  const tsMs = parseIngestedMs(ts);
  if (tsMs == null || !tsWindowOk(tsMs, data)) {
    return { ok: false, reason: 'invalid_or_stale_ts_ingested_ms' };
  }
  if (typeof dig !== 'string' || dig.trim().length !== 64) {
    return { ok: false, reason: 'invalid_receipt_digest' };
  }
  try {
    const expect = await sha256HexUtf8(pythonSortKeysJsonStringify(core));
    if (expect.toLowerCase() !== dig.trim().toLowerCase()) {
      return { ok: false, reason: 'receipt_digest_mismatch' };
    }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  if (!registerUiPollRecordId('smiles', rid.trim())) {
    return { ok: false, reason: 'duplicate_record_id' };
  }
  return { ok: true, smiles: core.smiles, recordId: rid.trim() };
}

/**
 * @param {object} data
 * @returns {Promise<{ ok: boolean, reason?: string, recordId?: string }>}
 */
export async function validateUiPollMidiReceipt(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'empty' };
  const events = data.events ?? data.midi_events;
  if (!Array.isArray(events) || events.length === 0) return { ok: false, reason: 'missing_events' };
  if (data.consumed === true) return { ok: false, reason: 'consumed_flag' };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') return { ok: false, reason: `bad_event_${i}` };
    const st = Number(ev.start);
    const dur = Number(ev.duration);
    if (!Number.isFinite(st) || st < 0 || !Number.isFinite(dur) || dur < 0) {
      return { ok: false, reason: `bad_time_${i}` };
    }
    const note = ev.note != null ? Number(ev.note) : Number(ev.midi);
    if (!Number.isFinite(note) || note < 0 || note > 127 || Math.floor(note) !== note) {
      return { ok: false, reason: `bad_note_${i}` };
    }
  }

  const core = midiCoreFromEnvelope(data);
  const rid = data.record_id;
  const ts = data.ts_ingested_ms;
  const dig = data.receipt_digest;

  if (receiptAllMissing(data)) {
    return { ok: true, recordId: '' };
  }

  if (typeof rid !== 'string' || !UI_POLL_RECORD_ID_RE.test(rid.trim())) {
    return { ok: false, reason: 'invalid_record_id' };
  }
  const tsMs = parseIngestedMs(ts);
  if (tsMs == null || !tsWindowOk(tsMs, data)) {
    return { ok: false, reason: 'invalid_or_stale_ts_ingested_ms' };
  }
  if (typeof dig !== 'string' || dig.trim().length !== 64) {
    return { ok: false, reason: 'invalid_receipt_digest' };
  }
  try {
    const expect = await sha256HexUtf8(pythonSortKeysJsonStringify(core));
    if (expect.toLowerCase() !== dig.trim().toLowerCase()) {
      return { ok: false, reason: 'receipt_digest_mismatch' };
    }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  if (!registerUiPollRecordId('midi', rid.trim())) {
    return { ok: false, reason: 'duplicate_record_id' };
  }
  return { ok: true, recordId: rid.trim() };
}

/**
 * 供 glass 轮询日志使用：`validateUiPollMidiReceipt` 的 `reason` → 中文排查提示。
 * @param {string} [reason]
 * @returns {string}
 */
export function describeMidiPollRejectReason(reason) {
  const r = String(reason || '').trim();
  const hints = {
    receipt_digest_mismatch:
      '摘要与正文不一致：请确认 MIDI 由本仓库 8082（ui_poll_receiver）入队，未经其它服务改写 events/bpm/molecule_id；中间层勿对 JSON 再序列化改键序或数值类型。',
    invalid_or_stale_ts_ingested_ms:
      'ts_ingested_ms 超出允许窗口：若轮询 JSON 含 `server_emit_ms`（8082 新版），请确认包在 8082 上停留未超过约 15 分钟；否则请校时浏览器与 8082（误差建议 <15 分钟）。',
    invalid_receipt_digest: 'receipt_digest 非 64 位 hex：8082 返回体可能被代理截断或篡改。',
    invalid_record_id: 'record_id 非 UIP- 格式：响应不是本仓库 8082 生成的轮询包。',
    duplicate_record_id: '同一 record_id 已消费过：多标签页或重复轮询；可刷新页面清空前端去重环。',
    consumed_flag: '包已标为 consumed：勿对 GET 响应二次校验。',
    missing_events: '缺少 events / midi_events：推送体不完整。',
    empty: '轮询返回体为空或非对象。'
  };
  if (hints[r]) return hints[r];
  if (r.includes('crypto.subtle.digest') && r.includes('receipt_digest')) {
    return '非安全页面（常见：`http://` + 局域网 IP）下浏览器不提供 `crypto.subtle`：请更新到含纯 JS SHA-256 回退的版本，或改用 HTTPS / localhost 访问。';
  }
  if (r.startsWith('bad_event_') || r.startsWith('bad_time_') || r.startsWith('bad_note_')) {
    return 'events 某项格式非法：每项须为对象，且含 start、duration、note 或 midi（0–127 整数）。';
  }
  return r ? `其它原因：${r}` : '';
}

/**
 * 玻璃整包会话：SMILES + 整首 MIDI events + bpm +（可选）揭晓前秒数，与 `POST /__push/glass_session` 业务核一致。
 * @param {object} data
 */
export function glassSessionCoreFromEnvelope(data, opts = {}) {
  const includeLegacy编号 = opts.includeLegacy编号 !== false;
  const sm = String(data?.smiles ?? data?.SMILES ?? data?.sm ?? '').trim();
  const rawEv = data?.events ?? data?.midi_events;
  let events = [];
  if (Array.isArray(rawEv)) {
    try {
      events = JSON.parse(JSON.stringify(rawEv));
    } catch {
      events = [];
    }
  }
  const br = data?.bpm;
  let bpm = 100;
  if (br != null && br !== '') {
    const n = Number(br);
    bpm = Number.isFinite(n) ? Math.trunc(n) : 100;
  }
  if (bpm === 0) bpm = 100;
  let rls = 5;
  const rr = data?.reveal_last_sec;
  if (rr != null && rr !== '') {
    const n = Number(rr);
    if (Number.isFinite(n)) rls = Math.max(1, Math.min(60, Math.round(n)));
  }
  const o = { bpm, events, reveal_last_sec: rls, smiles: sm };
  if (includeLegacy编号 && data != null && data['编号'] !== undefined && data['编号'] !== null) {
    o['编号'] = data['编号'];
  }
  const midFirst = data?.molecule_id ?? data?.moleculeId ?? data?.['药物编号'] ?? data?.['编号'];
  if (midFirst != null && midFirst !== '') {
    o.molecule_id = midFirst;
  }
  return o;
}

/**
 * `GET …/glass_session_ui_pending` 整包校验（**须**带齐回执三字段，不做兼容缺省）。
 * @param {object} data
 * @returns {Promise<{ ok: boolean, reason?: string, smiles?: string, recordId?: string, revealLastSec?: number }>}
 */
export async function validateGlassSessionReceipt(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'empty' };
  if (!Object.keys(data).length) return { ok: false, reason: 'empty_object' };

  const events = data.events ?? data.midi_events;
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: 'missing_events' };
  }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') return { ok: false, reason: `bad_event_${i}` };
    const st = Number(ev.start);
    const dur = Number(ev.duration);
    if (!Number.isFinite(st) || st < 0 || !Number.isFinite(dur) || dur < 0) {
      return { ok: false, reason: `bad_time_${i}` };
    }
    const note = ev.note != null ? Number(ev.note) : Number(ev.midi);
    if (!Number.isFinite(note) || note < 0 || note > 127 || Math.floor(note) !== note) {
      return { ok: false, reason: `bad_note_${i}` };
    }
  }

  const core = glassSessionCoreFromEnvelope(data);
  if (!core.smiles) return { ok: false, reason: 'missing_smiles' };

  const rid = data.record_id;
  const ts = data.ts_ingested_ms;
  const dig = data.receipt_digest;

  if (typeof rid !== 'string' || !UI_POLL_RECORD_ID_RE.test(rid.trim())) {
    return { ok: false, reason: 'invalid_record_id' };
  }
  const tsMs = parseIngestedMs(ts);
  if (tsMs == null || !tsWindowOk(tsMs, data)) {
    return { ok: false, reason: 'invalid_or_stale_ts_ingested_ms' };
  }
  if (typeof dig !== 'string' || dig.trim().length !== 64) {
    return { ok: false, reason: 'invalid_receipt_digest' };
  }
  try {
    const expect = await sha256HexUtf8(pythonSortKeysJsonStringify(core));
    if (expect.toLowerCase() !== dig.trim().toLowerCase()) {
      /**
       * 兼容：服务端出队时可能为方便展示附加 `编号`（且与 molecule_id 同值），
       * 但该字段不一定参与入队摘要。此时尝试去掉 `编号` 二次比对，避免误拒收。
       */
      const has编号 = data != null && data['编号'] !== undefined && data['编号'] !== null;
      const mid = data?.molecule_id ?? data?.moleculeId ?? data?.['药物编号'];
      if (!(has编号 && mid != null && String(mid) === String(data['编号']))) {
        return { ok: false, reason: 'receipt_digest_mismatch' };
      }
      const coreNoLegacyId = glassSessionCoreFromEnvelope(data, { includeLegacy编号: false });
      const expectNoLegacyId = await sha256HexUtf8(pythonSortKeysJsonStringify(coreNoLegacyId));
      if (expectNoLegacyId.toLowerCase() !== dig.trim().toLowerCase()) {
        return { ok: false, reason: 'receipt_digest_mismatch' };
      }
    }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  if (!registerUiPollRecordId('session', rid.trim())) {
    return { ok: false, reason: 'duplicate_record_id' };
  }
  return {
    ok: true,
    smiles: core.smiles,
    recordId: rid.trim(),
    revealLastSec: core.reveal_last_sec
  };
}
