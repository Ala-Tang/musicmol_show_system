import {
  getBoundMusicMolApiBase,
  getBoundMusicMolUiPollBase,
  isMusicMol5020BindingLocked,
  normalizeMusicMolServiceOrigin,
  resolveMappedMusicMolApiBase,
  resolveMappedUiPollHostname
} from './musicMol5020Binding.js';

export const MOLECULE_SUBMIT_PATH = '/api/molecule_submit';
export const MIDI_EXCHANGE_PATH = '/api/midi_exchange';
/** 5020 播放服务端「示例钢琴MIDI合集」目录内已收录曲目 */
export const PLAY_EXAMPLE_MIDI_PATH = '/api/play_example_midi';

/** 映射端→5020：可选交互日志（见 `musicMol5020ApiLogger.global.js`，需显式开启） */
function emit5020ApiLog(entry) {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.painojsLog5020ApiEvent === 'function') {
      globalThis.painojsLog5020ApiEvent(entry);
    }
  } catch (_) {}
}

/** @param {string} baseUrl */
function rejectUnlessExternalBaseMatchesBinding(baseUrl) {
  if (!isMusicMol5020BindingLocked()) return null;
  const bound = getBoundMusicMolApiBase();
  if (!bound) return null;
  const want = normalizeMusicMolServiceOrigin(resolveMappedMusicMolApiBase(bound));
  const got = normalizeMusicMolServiceOrigin(resolveMappedMusicMolApiBase(baseUrl));
  if (!want || !got || want !== got) {
    return {
      ok: false,
      skipped: true,
      reason: 'musicmol_5020_binding_rejected',
      message: '已启用外设固定绑定：拒绝发往未绑定部署的请求'
    };
  }
  return null;
}

/** @param {string} baseUrl */
function rejectUnlessUiPollBaseMatchesBinding(baseUrl) {
  if (!isMusicMol5020BindingLocked()) return null;
  const bound = getBoundMusicMolUiPollBase();
  if (!bound) return null;
  const want = normalizeMusicMolServiceOrigin(resolveMappedUiPollHostname(bound));
  const got = normalizeMusicMolServiceOrigin(resolveMappedUiPollHostname(baseUrl));
  if (!want || !got || want !== got) {
    return {
      ok: false,
      skipped: true,
      reason: 'musicmol_ui_poll_binding_rejected',
      message: '已启用轮询基址固定绑定：拒绝访问未绑定接收端'
    };
  }
  return null;
}

/**
 * 将 SMILES 映射为稳定的简易 MIDI 事件序列，供 `/api/midi_exchange` 发送。
 * @param {string} smiles
 * @param {{ bpm?: number; maxEvents?: number }} [opts]
 * @returns {{note:number,start:number,duration:number}[]}
 */
/**
 * 根据 MIDI 事件序列估算结束时刻（ms），含收尾留白；供顶栏「演奏中」提示时长。
 * @param {{ start?: number; duration?: number; time?: number }[]} events
 * @param {number} [tailMs=500]
 */
export function estimateMidiPlaybackDurationMs(events, tailMs = 500) {
  if (!Array.isArray(events) || events.length === 0) {
    return Math.max(1200, tailMs);
  }
  let maxEnd = 0;
  for (const e of events) {
    const start = Number(e?.start ?? e?.time ?? 0) || 0;
    const dur = Number(e?.duration) || 0;
    maxEnd = Math.max(maxEnd, start + dur);
  }
  const raw = Math.ceil(maxEnd + tailMs);
  return Math.max(1200, raw);
}

export function midiEventsFromSmiles(smiles, opts = {}) {
  const s = String(smiles || '').trim();
  if (!s) return [];
  const bpm = Number(opts.bpm) || 100;
  const maxEvents = Math.max(
    4,
    Math.min(64, Math.floor(Number(opts.maxEvents) || 16))
  );
  const bp = Math.max(40, Math.min(240, Math.round(Number(bpm) || 100)));
  const beatMs = 60000 / bp;
  const step = Math.max(120, Math.round(beatMs / 2));
  const out = [];
  const chars = Array.from(s).filter((ch) => /[A-Za-z0-9@+\-\[\]=#\\/()]/.test(ch));
  if (!chars.length) return [];
  for (let i = 0; i < Math.min(chars.length, maxEvents); i++) {
    const code = chars[i].charCodeAt(0);
    const note = 48 + (code % 36);
    out.push({
      note: Math.max(0, Math.min(127, note)),
      start: i * step,
      duration: step
    });
  }
  return out;
}

/**
 * 手动模式等场景下向外部发送 SMILES（如大屏管线）；与 Swiss 面板内「显示分子数据」无强制绑定。
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.smiles
 * @param {number} [opts.bpm=100]
 * @param {number} [opts.timeoutMs=15000]
 * @param {string} [opts.sessionId] 联调手动进度 UI；写入 JSON `session_id`
 * @param {string} [opts.session_id]
 * @param {boolean} [opts.autoPlay] 为 true 时写入 `auto_play: true`，由 5020 在服务端生成并自动演奏，前端不再依赖 `midi_exchange` 占位 MIDI
 * @returns {Promise<{ ok: boolean; status?: number; data?: object; skipped?: boolean; reason?: string; error?: string; message?: string }>}
 */
export async function postMoleculeSubmit({
  baseUrl,
  smiles,
  bpm = 100,
  timeoutMs = 15000,
  sessionId,
  session_id,
  autoPlay
} = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) {
    emit5020ApiLog({
      kind: 'molecule_submit',
      method: 'POST',
      path: MOLECULE_SUBMIT_PATH,
      url: '',
      outcome: 'skipped',
      meta: { reason: 'no_base_url' }
    });
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessExternalBaseMatchesBinding(base);
  if (bindRej) {
    emit5020ApiLog({
      kind: 'molecule_submit',
      method: 'POST',
      path: MOLECULE_SUBMIT_PATH,
      url: `${base}${MOLECULE_SUBMIT_PATH}`,
      outcome: 'skipped',
      meta: { reason: bindRej.reason || 'binding' }
    });
    return bindRej;
  }
  const s = String(smiles || '').trim();
  if (!s) {
    emit5020ApiLog({
      kind: 'molecule_submit',
      method: 'POST',
      path: MOLECULE_SUBMIT_PATH,
      url: `${base}${MOLECULE_SUBMIT_PATH}`,
      outcome: 'skipped',
      meta: { reason: 'empty_smiles' }
    });
    return { ok: false, skipped: true, reason: 'empty_smiles' };
  }
  const bp = Math.max(40, Math.min(240, Math.round(Number(bpm) || 100)));
  const url = `${base}${MOLECULE_SUBMIT_PATH}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const payload = /** @type {Record<string, unknown>} */ ({ smiles: s, bpm: bp });
    const sid = sessionId ?? session_id;
    if (sid) payload.session_id = String(sid);
    if (autoPlay === true) payload.auto_play = true;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data?.ok !== false;
    const latencyMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    );
    emit5020ApiLog({
      kind: 'molecule_submit',
      method: 'POST',
      path: MOLECULE_SUBMIT_PATH,
      url,
      latencyMs,
      status: res.status,
      ok,
      outcome: ok ? 'success' : 'http_error',
      meta: {
        smilesLen: s.length,
        bpm: bp,
        hasSessionId: !!(sid),
        autoPlay: autoPlay === true,
        serverOk: data?.ok,
        httpOk: res.ok
      }
    });
    return { ok, status: res.status, data };
  } catch (e) {
    const latencyMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    );
    emit5020ApiLog({
      kind: 'molecule_submit',
      method: 'POST',
      path: MOLECULE_SUBMIT_PATH,
      url,
      latencyMs,
      outcome: 'network_error',
      meta: { error: e?.name || 'Error', message: String(e?.message || e || '').slice(0, 240) }
    });
    return {
      ok: false,
      error: e?.name || 'Error',
      message: String(e?.message || e)
    };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * 手动模式选择模型后自动发送 MIDI 到外部。
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {{note:number,start:number,duration:number}[]} opts.events
 * @param {number} [opts.bpm=100]
 * @param {string} [opts.label='manual_mode']
 * @param {string} [opts.source='painojs']
 * @param {number} [opts.timeoutMs=15000]
 * @param {string} [opts.sessionId] 与 {@link postMoleculeSubmit} 及 8082 进度接口一致
 * @param {string} [opts.session_id]
 * @returns {Promise<{ ok: boolean; status?: number; data?: object; skipped?: boolean; reason?: string; error?: string; message?: string }>}
 */
export async function postMidiExchange({
  baseUrl,
  events,
  bpm = 100,
  label = 'manual_mode',
  source = 'painojs',
  timeoutMs = 15000,
  sessionId,
  session_id
} = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) {
    emit5020ApiLog({
      kind: 'midi_exchange',
      method: 'POST',
      path: MIDI_EXCHANGE_PATH,
      url: '',
      outcome: 'skipped',
      meta: { reason: 'no_base_url' }
    });
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessExternalBaseMatchesBinding(base);
  if (bindRej) {
    emit5020ApiLog({
      kind: 'midi_exchange',
      method: 'POST',
      path: MIDI_EXCHANGE_PATH,
      url: `${base}${MIDI_EXCHANGE_PATH}`,
      outcome: 'skipped',
      meta: { reason: bindRej.reason || 'binding' }
    });
    return bindRej;
  }
  if (!Array.isArray(events) || events.length === 0) {
    emit5020ApiLog({
      kind: 'midi_exchange',
      method: 'POST',
      path: MIDI_EXCHANGE_PATH,
      url: `${base}${MIDI_EXCHANGE_PATH}`,
      outcome: 'skipped',
      meta: { reason: 'empty_events' }
    });
    return { ok: false, skipped: true, reason: 'empty_events' };
  }
  const bp = Math.max(40, Math.min(240, Math.round(Number(bpm) || 100)));
  const url = `${base}${MIDI_EXCHANGE_PATH}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const midiPayload = /** @type {Record<string, unknown>} */ ({
      events,
      bpm: bp,
      source,
      label
    });
    const sid = sessionId ?? session_id;
    if (sid) midiPayload.session_id = String(sid);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(midiPayload),
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data?.ok !== false;
    const latencyMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    );
    emit5020ApiLog({
      kind: 'midi_exchange',
      method: 'POST',
      path: MIDI_EXCHANGE_PATH,
      url,
      latencyMs,
      status: res.status,
      ok,
      outcome: ok ? 'success' : 'http_error',
      meta: {
        eventCount: events.length,
        bpm: bp,
        label,
        source,
        hasSessionId: !!(sid),
        serverOk: data?.ok,
        httpOk: res.ok
      }
    });
    return { ok, status: res.status, data };
  } catch (e) {
    const latencyMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    );
    emit5020ApiLog({
      kind: 'midi_exchange',
      method: 'POST',
      path: MIDI_EXCHANGE_PATH,
      url,
      latencyMs,
      outcome: 'network_error',
      meta: { error: e?.name || 'Error', message: String(e?.message || e || '').slice(0, 240) }
    });
    return {
      ok: false,
      error: e?.name || 'Error',
      message: String(e?.message || e)
    };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * 请求 5020 按文件名或 `song_key` 解析服务端「示例钢琴MIDI合集」目录下的 `.mid` 并入队演奏（与 `midi_exchange` 的 SMILES 派生 events 无关）。
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} [opts.filename] 与合集内文件名一致，如 `03_生日快乐_Happy_Birthday.mid`
 * @param {string} [opts.song_key] 与 `filename` 二选一，如 `生日快乐_Happy_Birthday`
 * @param {number} [opts.bpm] 仅在使用 `song_key` 时建议传入
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{ ok: boolean; status?: number; data?: object; skipped?: boolean; reason?: string; error?: string; message?: string }>}
 */
export async function postPlayExampleMidi({
  baseUrl,
  filename,
  song_key,
  bpm,
  timeoutMs = 15000
} = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) {
    emit5020ApiLog({
      kind: 'play_example_midi',
      method: 'POST',
      path: PLAY_EXAMPLE_MIDI_PATH,
      url: '',
      outcome: 'skipped',
      meta: { reason: 'no_base_url' }
    });
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessExternalBaseMatchesBinding(base);
  if (bindRej) {
    emit5020ApiLog({
      kind: 'play_example_midi',
      method: 'POST',
      path: PLAY_EXAMPLE_MIDI_PATH,
      url: `${base}${PLAY_EXAMPLE_MIDI_PATH}`,
      outcome: 'skipped',
      meta: { reason: bindRej.reason || 'binding' }
    });
    return bindRej;
  }
  const fn = String(filename || '').trim();
  const sk = String(song_key || '').trim();
  if (!fn && !sk) {
    emit5020ApiLog({
      kind: 'play_example_midi',
      method: 'POST',
      path: PLAY_EXAMPLE_MIDI_PATH,
      url: `${base}${PLAY_EXAMPLE_MIDI_PATH}`,
      outcome: 'skipped',
      meta: { reason: 'no_filename_or_song_key' }
    });
    return { ok: false, skipped: true, reason: 'no_filename_or_song_key' };
  }
  const payload = /** @type {Record<string, unknown>} */ ({});
  if (fn) {
    payload.filename = fn;
  } else {
    payload.song_key = sk;
    if (bpm != null && Number.isFinite(Number(bpm))) {
      payload.bpm = Math.max(40, Math.min(240, Math.round(Number(bpm))));
    }
  }
  const url = `${base}${PLAY_EXAMPLE_MIDI_PATH}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data?.ok !== false;
    const latencyMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    );
    emit5020ApiLog({
      kind: 'play_example_midi',
      method: 'POST',
      path: PLAY_EXAMPLE_MIDI_PATH,
      url,
      latencyMs,
      status: res.status,
      ok,
      outcome: ok ? 'success' : 'http_error',
      meta: {
        filename: fn || undefined,
        song_key: fn ? undefined : sk,
        serverOk: data?.ok,
        httpOk: res.ok
      }
    });
    return { ok, status: res.status, data };
  } catch (e) {
    const latencyMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    );
    emit5020ApiLog({
      kind: 'play_example_midi',
      method: 'POST',
      path: PLAY_EXAMPLE_MIDI_PATH,
      url,
      latencyMs,
      outcome: 'network_error',
      meta: { error: e?.name || 'Error', message: String(e?.message || e || '').slice(0, 240) }
    });
    return {
      ok: false,
      error: e?.name || 'Error',
      message: String(e?.message || e)
    };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * 将 MIDI 事件写入本仓库 UI 轮询接收端（`server/ui_poll_receiver/app.py` 的 `POST /__push/midi`），
 * 供 `GET …/midi_exchange/ui_pending` 被玻璃 iframe 拉取后本地演奏。
 * 与 `POST {MUSICMOL_API_BASE}/api/midi_exchange`（外设）分离；外设不代写 8082 时须由前端或脚本补这一条。
 * @param {{ baseUrl: string; events: object[]; bpm?: number; timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean; skipped?: boolean; status?: number; data?: object; error?: string; message?: string }>}
 */
export async function postPushMidiToUiPollReceiver({
  baseUrl,
  events,
  bpm = 100,
  timeoutMs = 12000
} = {}) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return { ok: false, skipped: true, reason: 'no_base_url' };
  const bindRej = rejectUnlessUiPollBaseMatchesBinding(base);
  if (bindRej) return bindRej;
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, skipped: true, reason: 'empty_events' };
  }
  const bp = Math.max(40, Math.min(240, Math.round(Number(bpm) || 100)));
  const url = `${base}/__push/midi`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, bpm: bp }),
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data?.ok !== false;
    return { ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      error: e?.name || 'Error',
      message: String(e?.message || e)
    };
  } finally {
    clearTimeout(tid);
  }
}

/** UI 轮询：待消费的 MIDI（服务端可覆盖路径） */
export const MIDI_UI_PENDING_PATH =
  (typeof globalThis !== 'undefined' && globalThis.MIDI_UI_PENDING_PATH) ||
  '/api/midi_exchange/ui_pending';
/** UI 轮询：待绑定的 SMILES 等 */
export const MOLECULE_MUSIC_UI_PENDING_PATH =
  (typeof globalThis !== 'undefined' && globalThis.MOLECULE_MUSIC_UI_PENDING_PATH) ||
  '/api/molecule_music_ui_pending';
/** UI 轮询：整首 MIDI + SMILES 一包（玻璃盒一次起播） */
export const GLASS_SESSION_UI_PENDING_PATH =
  (typeof globalThis !== 'undefined' && globalThis.GLASS_SESSION_UI_PENDING_PATH) ||
  '/api/glass_session_ui_pending';

/**
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export async function fetchMidiUiPending(
  baseUrl,
  { timeoutMs = 8000, signal, consume = false } = {}
) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) {
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessUiPollBaseMatchesBinding(base);
  if (bindRej) return bindRej;
  const q = consume ? '?consume=1' : '';
  const url = `${base}${MIDI_UI_PENDING_PATH}${q}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  const sig = signal || ctl.signal;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: sig,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name, message: String(e?.message || e) };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export async function fetchGlassSessionUiPending(
  baseUrl,
  { timeoutMs = 8000, signal } = {}
) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) {
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessUiPollBaseMatchesBinding(base);
  if (bindRej) return bindRej;
  const url = `${base}${GLASS_SESSION_UI_PENDING_PATH}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  const sig = signal || ctl.signal;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: sig,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name, message: String(e?.message || e) };
  } finally {
    clearTimeout(tid);
  }
}

export async function fetchSmilesTrackUiPending(
  baseUrl,
  { timeoutMs = 8000, signal, consume = false } = {}
) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) {
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessUiPollBaseMatchesBinding(base);
  if (bindRej) return bindRej;
  const q = consume ? '?consume=1' : '';
  const url = `${base}${MOLECULE_MUSIC_UI_PENDING_PATH}${q}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  const sig = signal || ctl.signal;
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: sig,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name, message: String(e?.message || e) };
  } finally {
    clearTimeout(tid);
  }
}

/** 手动「生成分子音乐」进度：往 8082 写入会话（generating） */
export const MANUAL_MOLECULE_MUSIC_SESSION_PUSH_PATH =
  (typeof globalThis !== 'undefined' && globalThis.MANUAL_MOLECULE_MUSIC_SESSION_PUSH_PATH) ||
  '/__push/manual_molecule_music_session';
/** 外设推送 playing / finished */
export const MANUAL_MOLECULE_MUSIC_PHASE_PUSH_PATH =
  (typeof globalThis !== 'undefined' && globalThis.MANUAL_MOLECULE_MUSIC_PHASE_PUSH_PATH) ||
  '/__push/manual_molecule_music_phase';
/** 浏览器轮询当前 phase */
export const MANUAL_MOLECULE_MUSIC_UI_STATUS_PATH =
  (typeof globalThis !== 'undefined' && globalThis.MANUAL_MOLECULE_MUSIC_UI_STATUS_PATH) ||
  '/api/manual_molecule_music_ui_status';

/**
 * @param {string} baseUrl
 * @param {{ session_id: string, smiles?: string, phase?: string }} body
 */
export async function postManualMoleculeMusicSession(
  baseUrl,
  body,
  { timeoutMs = 8000 } = {}
) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return { ok: false, skipped: true, reason: 'no_base_url' };
  const bindRej = rejectUnlessUiPollBaseMatchesBinding(base);
  if (bindRej) return bindRej;
  const url = `${base}${MANUAL_MOLECULE_MUSIC_SESSION_PUSH_PATH}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data?.ok !== false, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name, message: String(e?.message || e) };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * @param {string} baseUrl
 * @param {string} sessionId
 */
export async function fetchManualMoleculeMusicUiStatus(
  baseUrl,
  sessionId,
  { timeoutMs = 8000 } = {}
) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) {
    return { ok: false, skipped: true, reason: 'no_base_url' };
  }
  const bindRej = rejectUnlessUiPollBaseMatchesBinding(base);
  if (bindRej) return bindRej;
  const sid = encodeURIComponent(String(sessionId || '').trim());
  const url = `${base}${MANUAL_MOLECULE_MUSIC_UI_STATUS_PATH}?session_id=${sid}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name, message: String(e?.message || e) };
  } finally {
    clearTimeout(tid);
  }
}

export {
  validateUiPollSmilesReceipt,
  validateUiPollMidiReceipt,
  validateGlassSessionReceipt,
  describeMidiPollRejectReason,
  pythonSortKeysJsonStringify,
  smilesCoreFromEnvelope,
  midiCoreFromEnvelope,
  glassSessionCoreFromEnvelope,
  registerUiPollRecordId,
  clearUiPollRecordIdCache,
  UI_POLL_MAX_AGE_MS,
  UI_POLL_MAX_FUTURE_SKEW_MS,
  UI_POLL_RECORD_ID_RE
} from './uiPollReceipt.js';
