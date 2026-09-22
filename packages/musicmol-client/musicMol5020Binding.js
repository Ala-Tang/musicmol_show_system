/**
 * 将外设 HTTP API（典型 :5020）与 UI 轮询基址（典型 :8082）与本页固定绑定：
 * 绑定生效后 {@link getMusicMolApiBase} / {@link getMusicMolUiPollBase} 仅返回已保存基址，
 * 且 {@link ../api/musicMolApi.js} 会拒绝发往其它源的请求。
 *
 * 持久化：localStorage；并在绑定/解除时同步 `globalThis.MUSICMOL_*`，供 iframe（如 glass）读父页变量。
 */

const LS_LOCK = 'painojs.musicmol5020.lock';
const LS_API = 'painojs.musicmol5020.apiBase';
const LS_POLL = 'painojs.musicmol5020.uiPollBase';
const LS_PREV_API = 'painojs.musicmol5020.prevGlobalApi';
const LS_PREV_POLL = 'painojs.musicmol5020.prevGlobalPoll';

export const MUSICMOL_BINDING_CHANGED_EVENT = 'musicmol:binding-changed';

/**
 * 将误配的 UI 轮询端口 **8087** 规范为 **8082**（与本仓库 `ui_poll_receiver`、外设 `POST /__push/midi` 默认一致）。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeMusicMolUiPollBase(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!s) return s;
  try {
    const u = new URL(s);
    if (u.port === '8087') {
      u.port = '8082';
      return u.toString().replace(/\/$/, '');
    }
  } catch (_) {
    /* */
  }
  return s;
}

/**
 * `mapped` 栈且当前页有可用 hostname 时，将 **:8082** 轮询 URL 的主机改为 `location.hostname`，
 * 使端口映射侧（浏览器地址栏为 .43）轮询 `.43:8082`，而非 JSON/绑定里残留的本机 .26 或 127.0.0.1。
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveMappedUiPollHostname(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!s) return s;
  try {
    const cfg = typeof globalThis !== 'undefined' ? globalThis.__PAINOJS_STACK_CONFIG__ : null;
    if (!cfg || cfg.mode !== 'mapped') return s;
    if (typeof location === 'undefined' || !location.hostname) return s;
    const lh = String(location.hostname).trim();
    if (!lh || lh === '127.0.0.1' || lh === 'localhost') return s;
    const u = new URL(s);
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (String(p) !== '8082') return s;
    if (u.hostname === lh) return s;
    u.hostname = lh;
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return s;
  }
}

/**
 * `mapped` 栈下浏览器发往 **5020** 的主机应与页面同源或可映射入口一致：
 * - localhost → browserReachable5020Host 或 location.hostname 或 external5020Host
 * - 绑定里写成 external5020Host（外设真实 IP）而浏览器只能访问映射入口时 → 改为 browserReachable5020Host 或当前页 hostname
 * 恢复只用真实外设 IP：`globalThis.PAINOJS_MAPPED_BROWSER_USE_EXTERNAL_5020 === true`
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveMappedMusicMolApiBase(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!s) return s;
  try {
    const cfg = typeof globalThis !== 'undefined' ? globalThis.__PAINOJS_STACK_CONFIG__ : null;
    if (!cfg || cfg.mode !== 'mapped') return s;
    const useExtBrowser =
      typeof globalThis !== 'undefined' && globalThis.PAINOJS_MAPPED_BROWSER_USE_EXTERNAL_5020 === true;
    if (useExtBrowser) return s;
    if (typeof location === 'undefined' || !location.hostname) return s;
    const lh = String(location.hostname).trim();
    if (!lh || lh === '127.0.0.1' || lh === 'localhost') return s;

    const ext = String(cfg.external5020Host || '').trim();
    const br = String(cfg.browserReachable5020Host || '').trim();

    const u = new URL(s);
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (String(p) !== '5020') return s;

    const isLoop = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (isLoop) {
      u.hostname = br || lh;
      return u.toString().replace(/\/$/, '');
    }

    if (ext && u.hostname === ext && lh !== ext) {
      /** 展陈机真实 IP 与浏览器 NAT 入口不同时，以地址栏为准（与 stack-bootstrap 5020 一致） */
      u.hostname = lh;
      return u.toString().replace(/\/$/, '');
    }

    /**
     * 绑定或历史配置里写了 **本机 projectBind / 映射 JSON 里的主机**（如 10.70.160.26），
     * 展陈浏览器却从 **NAT 入口**（如 lanClientHost 10.70.160.43）打开页面时：若不重写，
     * 请求仍发往 .26，客户端侧往往无路由 →「映射端不能与 5020 通信」。
     * 与 stack-bootstrap 未绑定时「5020 跟 address bar 同主机」对齐。
     */
    const pb = String(cfg.projectBindHost || '').trim();
    const mh = String(cfg.mappedHost || '').trim();
    const lc = String(cfg.lanClientHost || '').trim();
    const infra = new Set([ext, pb, mh, lc].filter(Boolean));
    if (lh && u.hostname !== lh && infra.has(u.hostname)) {
      /** 勿用 br 覆盖 lh：JSON 里 browserReachable5020Host 可能落后于用户当前 NAT IP */
      u.hostname = lh;
      return u.toString().replace(/\/$/, '');
    }

    return s;
  } catch (_) {
    return s;
  }
}

function assertBindableHttpUrl(u) {
  const x = new URL(u);
  if (x.protocol !== 'http:' && x.protocol !== 'https:') {
    throw new Error('invalid-protocol');
  }
}

export function getBoundMusicMolApiBase() {
  try {
    const v = localStorage.getItem(LS_API);
    return v ? String(v).trim().replace(/\/$/, '') : '';
  } catch (_) {
    return '';
  }
}

export function getBoundMusicMolUiPollBase() {
  try {
    const v = localStorage.getItem(LS_POLL);
    if (!v) return '';
    const raw = String(v).trim().replace(/\/$/, '');
    const norm = normalizeMusicMolUiPollBase(raw);
    if (norm && norm !== raw) {
      try {
        localStorage.setItem(LS_POLL, norm);
      } catch (_) {
        /* */
      }
    }
    return norm;
  } catch (_) {
    return '';
  }
}

/**
 * 绑定锁开启条件：`lock` 标记且两端基址均为合法绝对 URL。
 * @returns {boolean}
 */
export function isMusicMol5020BindingLocked() {
  try {
    if (localStorage.getItem(LS_LOCK) !== '1') return false;
    const api = getBoundMusicMolApiBase();
    const poll = getBoundMusicMolUiPollBase();
    if (!api || !poll) return false;
    assertBindableHttpUrl(api);
    assertBindableHttpUrl(poll);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 将基址规范为「协议 + 主机 + 端口」，用于比较是否同一部署入口。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeMusicMolServiceOrigin(baseUrl) {
  const s = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${u.hostname}:${port}`;
  } catch (_) {
    return '';
  }
}

/**
 * 展示用：外设部署 `host:port`（不含协议）。
 * @param {string} baseUrl
 * @returns {string}
 */
export function formatBoundDeploymentLabel(baseUrl) {
  const o = normalizeMusicMolServiceOrigin(baseUrl);
  if (!o) return '—';
  try {
    const u = new URL(o);
    const port = u.port || '';
    return port ? `${u.hostname}:${port}` : u.hostname;
  } catch (_) {
    return o;
  }
}

function dispatchBindingChanged() {
  try {
    window.dispatchEvent(new CustomEvent(MUSICMOL_BINDING_CHANGED_EVENT));
  } catch (_) {}
}

/**
 * 页面加载后调用：若存在有效绑定，覆盖 `globalThis` 上的基址，与 config getter 一致。
 */
export function syncGlobalThisWithMusicMolBinding() {
  if (!isMusicMol5020BindingLocked()) return;
  const api = getBoundMusicMolApiBase();
  const poll = getBoundMusicMolUiPollBase();
  if (!api || !poll) return;
  try {
    globalThis.MUSICMOL_API_BASE = resolveMappedMusicMolApiBase(api).trim().replace(/\/$/, '');
    globalThis.MUSICMOL_UI_POLL_BASE = normalizeMusicMolUiPollBase(resolveMappedUiPollHostname(poll));
  } catch (_) {}
}

/**
 * @param {string} apiBase
 * @param {string} uiPollBase
 */
export function commitMusicMol5020Binding(apiBase, uiPollBase) {
  const api = String(apiBase || '').trim().replace(/\/$/, '');
  const poll = normalizeMusicMolUiPollBase(String(uiPollBase || '').trim().replace(/\/$/, ''));
  if (!api || !poll) throw new Error('api-and-poll-required');
  assertBindableHttpUrl(api);
  assertBindableHttpUrl(poll);

  let wasLocked = false;
  try {
    wasLocked = localStorage.getItem(LS_LOCK) === '1';
  } catch (_) {}

  if (!wasLocked) {
    try {
      const prevApi = Object.prototype.hasOwnProperty.call(globalThis, 'MUSICMOL_API_BASE')
        ? String(globalThis.MUSICMOL_API_BASE ?? '')
        : '';
      const prevPoll = Object.prototype.hasOwnProperty.call(globalThis, 'MUSICMOL_UI_POLL_BASE')
        ? String(globalThis.MUSICMOL_UI_POLL_BASE ?? '')
        : '';
      localStorage.setItem(LS_PREV_API, prevApi);
      localStorage.setItem(LS_PREV_POLL, prevPoll);
    } catch (_) {}
  }

  try {
    localStorage.setItem(LS_API, api);
    localStorage.setItem(LS_POLL, poll);
    localStorage.setItem(LS_LOCK, '1');
  } catch (e) {
    throw e;
  }

  try {
    globalThis.MUSICMOL_API_BASE = resolveMappedMusicMolApiBase(api).trim().replace(/\/$/, '');
    globalThis.MUSICMOL_UI_POLL_BASE = normalizeMusicMolUiPollBase(resolveMappedUiPollHostname(poll));
  } catch (_) {}

  dispatchBindingChanged();
}

export function releaseMusicMol5020Binding() {
  let prevApi = '';
  let prevPoll = '';
  try {
    prevApi = localStorage.getItem(LS_PREV_API) ?? '';
    prevPoll = localStorage.getItem(LS_PREV_POLL) ?? '';
  } catch (_) {}

  try {
    localStorage.removeItem(LS_LOCK);
    localStorage.removeItem(LS_API);
    localStorage.removeItem(LS_POLL);
    localStorage.removeItem(LS_PREV_API);
    localStorage.removeItem(LS_PREV_POLL);
  } catch (_) {}

  try {
    const a = String(prevApi).trim().replace(/\/$/, '');
    const p = String(prevPoll).trim().replace(/\/$/, '');
    if (a) globalThis.MUSICMOL_API_BASE = a;
    if (p) globalThis.MUSICMOL_UI_POLL_BASE = p;
  } catch (_) {}

  dispatchBindingChanged();
}
