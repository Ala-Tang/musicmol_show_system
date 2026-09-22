/**
 * 88 键钢琴白键共 52 个；视窗默认 whiteVisible 个白键（28–52 可调，与顶栏透明框缩放联动）。
 */
const MIDI_MIN = 21;
const MIDI_MAX = 108;
const WHITE_VISIBLE_MIN = 28;
const WHITE_VISIBLE_MAX = 52;
const WHITE_VISIBLE_DEFAULT = 40;
let whiteVisible = WHITE_VISIBLE_DEFAULT;
const APP_WIDTH = 1920;

/** MusicMol API 根地址（与 `piano/main.js`、`api-molecule-play.js` 一致）。
 * 映射端口若只托管静态而 Flask 在本机 :5020，须指向 `http://同主机:5020`，否则会 net::ERR_CONNECTION_REFUSED。
 * 覆盖（优先级从高到低）：
 * - window.MUSICMOL_API_BASE
 * - ?musicmol_api=http://主机:端口（显式指定推理 API）
 * - ?musicmol_same_origin=1（反向代理把整站映射到单一端口时，API 与页面同源，勿再指向 :5020）
 * 默认：8081/8766 → 同主机 :5020；5020 → 同源；其它端口 → 同主机 :5020（常见：静态页连独立 Flask）
 */
function getApiBase() {
  if (typeof window !== "undefined" && window.MUSICMOL_API_BASE) {
    return String(window.MUSICMOL_API_BASE).replace(/\/$/, "");
  }
  try {
    const sp = new URLSearchParams(typeof window !== "undefined" && window.location && window.location.search || "");
    const apiParam = sp.get("musicmol_api");
    if (apiParam && /^https?:\/\//i.test(apiParam)) return apiParam.replace(/\/$/, "");
    const sameOrigin =
      sp.get("musicmol_same_origin") === "1" ||
      sp.get("musicmol_same_origin") === "true" ||
      (typeof window !== "undefined" && window.MUSICMOL_API_SAME_ORIGIN === true);
    if (sameOrigin && typeof location !== "undefined" && location.origin && location.protocol !== "file:") {
      return String(location.origin).replace(/\/$/, "");
    }
  } catch {
    /* ignore */
  }
  if (typeof location === "undefined" || !location.href) return "http://127.0.0.1:5020";
  if (location.protocol === "file:") return "http://127.0.0.1:5020";
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  const host = location.hostname || "127.0.0.1";
  const proto = location.protocol === "https:" ? "https:" : "http:";
  if (port === "8081" || port === "8766") return `${proto}//${host}:5020`.replace(/\/$/, "");
  if (port === "5020") return (location.origin || "").replace(/\/$/, "");
  try {
    if (typeof globalThis !== "undefined" && globalThis.MUSICMOL_UNIFIED_SERVER === true) {
      return (location.origin || "").replace(/\/$/, "");
    }
  } catch {
    /* ignore */
  }
  return `${proto}//${host}:5020`.replace(/\/$/, "");
}

const API_BASE = getApiBase();

/**
 * PainoJS `unified-single.html`：展陈（Three / 玻璃）与钢琴同 document，模式与待播 MIDI 由主应用内联传递，
 * 不再对静态页 origin 轮询 `…/api/*_ui_pending` 或 `piano_interaction_mode`（避免 8766 上 404）。
 */
function isPainojsUnifiedSingleSameDocument() {
  try {
    return (
      typeof document !== "undefined" &&
      document.documentElement &&
      document.documentElement.classList.contains("unified-single")
    );
  } catch {
    return false;
  }
}

/** 浏览器直连 8082 时的 fetch 默认项（与 postRealtimeMidiOutbound → :5020 一致，映射跨域需明确 cors） */
const FETCH_OUTBOUND8082_DEFAULTS = { mode: "cors", credentials: "omit", cache: "no-store" };

/** 项目外 8082 服务基址（浏览器直接 POST glass_session 等；非本仓库实现的接口） */
function getOutbound8082Base() {
  if (typeof window !== "undefined" && window.MUSICMOL_OUTBOUND_BASE) {
    return String(window.MUSICMOL_OUTBOUND_BASE).replace(/\/$/, "");
  }
  // 勿写死历史 IP（换网口会变）；正常应通过 http://<当前主机>:5020 打开，此处与同主机 :8082 对齐
  const lanDefault = "http://127.0.0.1:8082";
  if (typeof location === "undefined" || !location.href) return lanDefault;
  if (location.protocol === "file:") return lanDefault;
  const host = location.hostname || "";
  const proto = location.protocol === "https:" ? "https:" : "http:";
  // 仅在本机打开 5020 页面且由本机进程消费 8082 时使用环回；局域网映射访问用页面 hostname（与推送目标一致）
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return `${proto}//127.0.0.1:8082`.replace(/\/$/, "");
  }
  if (!host) return lanDefault;
  return `${proto}//${host}:8082`.replace(/\/$/, "");
}

/** 上报分子音乐演奏阶段到 8082（UI 阶段联动：playing / finished） */
function postManualMoleculeMusicPhase(sessionId, phase) {
  const sid = sessionId || "";
  if (!sid) return;
  const url = `${getOutbound8082Base()}/__push/manual_molecule_music_phase`;
  void fetch(url, {
    ...FETCH_OUTBOUND8082_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sid, phase }),
  }).catch(() => {});
}

/**
 * 将示例曲序列组为外向 JSON 用的事件列表（毫秒）：{ note, start, duration }（与对方 `glass_session` 文档约定一致即可）。
 * @param {{ midi: number, startMs: number, endMs: number }[]} seq
 */
function buildGlassSessionEventsFromSongSeq(seq) {
  if (!seq || !seq.length) return [];
  return seq.map((e) => ({
    note: e.midi,
    start: Math.round(e.startMs),
    duration: Math.round(Math.max(40, e.endMs - e.startMs)),
  }));
}

/**
 * 向 **项目外** 8082 `POST /__push/glass_session` 发送整包 JSON（不阻塞原有演奏；不处理回执）。
 * 8082 当前只接受 full 形态（必须同时提供 smiles + events），因此所有模式都发 full。
 * mode: "midi" 时用占位 smiles + 完整 events（播放/按键阶段）；
 * mode: "smiles" 时用真实 smiles + 最小占位 events（推理完成阶段，避免重复发送 MIDI）。
 * songKey 为 null 时用于用户实时演奏场景（不从 SONG_GLASS_META 取配置）。
 */
function postGlassSession(songKey, seq, inferredSmiles = null, inferredMeta = null, mode = "smiles") {
  let events = buildGlassSessionEventsFromSongSeq(seq);

  // BPM 优先从模型 meta 取，其次预配置，默认 100
  const meta = songKey && (typeof window !== "undefined" && window.SONG_GLASS_META && window.SONG_GLASS_META[songKey]) || null;
  let bpm = 100;
  if (inferredMeta && inferredMeta.bpm != null && Number.isFinite(Number(inferredMeta.bpm))) {
    bpm = Number(inferredMeta.bpm);
  } else if (meta && meta.bpm != null && Number.isFinite(Number(meta.bpm))) {
    bpm = Number(meta.bpm);
  }

  const reveal_last_sec =
    meta && meta.reveal_last_sec != null && Number.isFinite(Number(meta.reveal_last_sec))
      ? Number(meta.reveal_last_sec)
      : 5;

  const smiles = mode === "smiles" && inferredSmiles && String(inferredSmiles).trim()
    ? String(inferredSmiles).trim()
    : "pending";

  // mode === "smiles" 时用最小占位 event 避免重复发送 MIDI
  // （点歌场景：播放时已发过完整 events；用户演奏场景：按键时已逐条发过 events）
  if (mode === "smiles") {
    events = [{ note: 60, start: 0, duration: 1 }];
  }

  // 8082 要求 events 非空
  if (!events.length) return;

  const body = { smiles, bpm, reveal_last_sec, events };

  const mid =
    meta && (meta.molecule_id ?? meta.moleculeId ?? meta["编号"] ?? meta["药物编号"] ?? meta.编号 ?? meta.药物编号);
  if (mid != null && String(mid).trim() !== "") body.molecule_id = String(mid).trim();

  const url = `${getOutbound8082Base()}/__push/glass_session`;
  void fetch(url, {
    ...FETCH_OUTBOUND8082_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** 兼容旧名 */
function postGlassSessionForDemoSong(songKey, seq, inferredSmiles, inferredMeta, mode) {
  return postGlassSession(songKey, seq, inferredSmiles, inferredMeta, mode);
}

/** 用于 innerHTML 展示 SMILES 等用户数据 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const BLACK_AFTER_PC = new Set([0, 2, 5, 7, 9]); // C D F G A 后有黑键

function isWhite(m) {
  return WHITE_PC.has(m % 12);
}

/** @returns {number[]} */
function allWhiteMidis() {
  const out = [];
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (isWhite(m)) out.push(m);
  }
  return out;
}

const WHITE_MIDIS = allWhiteMidis();
const WHITE_TOTAL = WHITE_MIDIS.length;

function getMaxStart() {
  return Math.max(0, WHITE_TOTAL - whiteVisible);
}

/**
 * minimap 与主键盘几何一致：52 个白键等分全宽；黑键宽 = 白键宽×0.58；
 * 黑键水平中心在相邻白键分界（与 gatherBlackPlacements 理想 center 一致）。
 */
const MM_WHITE_W_PCT = 100 / WHITE_TOTAL;
const MM_BLACK_W_PCT = MM_WHITE_W_PCT * 0.58;

const MM_BLACK_SPECS = (() => {
  const specs = new Map();
  WHITE_MIDIS.forEach((wm, idx) => {
    if (!BLACK_AFTER_PC.has(wm % 12)) return;
    const bm = wm + 1;
    if (bm > MIDI_MAX) return;
    const centerPct = (idx + 1) * MM_WHITE_W_PCT;
    specs.set(bm, {
      left: centerPct - MM_BLACK_W_PCT / 2,
      width: MM_BLACK_W_PCT,
    });
  });
  return specs;
})();

function minimapVisualBoundsForMidi(m) {
  if (isWhite(m)) {
    const i = WHITE_MIDIS.indexOf(m);
    if (i < 0) return { left: 0, width: MM_WHITE_W_PCT };
    return { left: i * MM_WHITE_W_PCT, width: MM_WHITE_W_PCT };
  }
  const b = MM_BLACK_SPECS.get(m);
  if (b) return { left: b.left, width: b.width };
  return { left: 0, width: MM_BLACK_W_PCT };
}

/** 当前白键视窗内出现的所有 MIDI（白键切片 + 该窗内黑键） */
function visibleMidiSpanForWhiteStart(ws) {
  const slice = WHITE_MIDIS.slice(ws, ws + whiteVisible);
  if (!slice.length) return { minM: MIDI_MIN, maxM: MIDI_MAX };
  const raw = gatherBlackPlacements(ws);
  let minM = slice[0];
  let maxM = slice[slice.length - 1];
  for (const r of raw) {
    minM = Math.min(minM, r.midi);
    maxM = Math.max(maxM, r.midi);
  }
  return { minM, maxM };
}

function minimapViewportPercents(ws) {
  const { minM, maxM } = visibleMidiSpanForWhiteStart(ws);
  const lo = minimapVisualBoundsForMidi(minM);
  const hi = minimapVisualBoundsForMidi(maxM);
  const leftPct = lo.left;
  const right = hi.left + hi.width;
  const widthPct = Math.max(0.05, Math.min(100 - leftPct, right - leftPct));
  return { leftPct, widthPct };
}

function midiToLabel(m) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const oct = Math.floor(m / 12) - 1;
  return `${names[m % 12]}${oct}`;
}

/** 与 midiToLabel 中八度数字一致，用于配色（约 0…8） */
function octaveClass(m) {
  const o = Math.floor(m / 12) - 1;
  const clamped = Math.max(0, Math.min(8, o));
  return `oct-${clamped}`;
}

function verifyPianoRange() {
  const whites = [];
  const blacks = [];
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (isWhite(m)) whites.push(m);
    else blacks.push(m);
  }
  const ok =
    whites.length === 52 &&
    blacks.length === 36 &&
    MIDI_MAX - MIDI_MIN + 1 === 88 &&
    WHITE_MIDIS.length === 52 &&
    WHITE_TOTAL === WHITE_MIDIS.length;
  if (!ok) {
    console.warn("[钢琴] 键域自检异常", {
      whiteCount: whites.length,
      blackCount: blacks.length,
      chromatic: MIDI_MAX - MIDI_MIN + 1,
    });
  }
  return ok;
}

/**
 * 高音谱表 / 低音谱表：以全部白键 MIDI 为锚点（仅自然音级），
 * 黑键纵坐标取相邻两白键之间的线性插值，避免非自然音级误入锚点表。
 */
function buildStaffAnchorTable(midis, yLowMidi, yHighMidi) {
  if (!midis.length) return [];
  if (midis.length === 1) return [{ m: midis[0], y: (yLowMidi + yHighMidi) / 2 }];
  return midis.map((m, i) => ({
    m,
    y: yLowMidi + (i / (midis.length - 1)) * (yHighMidi - yLowMidi),
  }));
}

const BASS_NATURAL_Y = buildStaffAnchorTable(
  WHITE_MIDIS.filter((m) => m <= 55),
  72,
  56
);

const TREBLE_NATURAL_Y = buildStaffAnchorTable(
  WHITE_MIDIS.filter((m) => m > 55),
  56,
  10
);

function lerpStaffY(table, midi) {
  if (midi <= table[0].m) {
    const a = table[0];
    return a.y + (a.m - midi) * 0.35;
  }
  const last = table[table.length - 1];
  if (midi >= last.m) {
    return last.y - (midi - last.m) * 0.35;
  }
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (midi >= a.m && midi <= b.m) {
      if (b.m === a.m) return a.y;
      return a.y + ((midi - a.m) / (b.m - a.m)) * (b.y - a.y);
    }
  }
  return last.y;
}

/** 以 C4=60 为分界：低音谱表 / 高音谱表 */
function staffYForMidi(midi) {
  const table = midi <= 55 ? BASS_NATURAL_Y : TREBLE_NATURAL_Y;
  return lerpStaffY(table, midi);
}

/**
 * 每个 MIDI 键固定一套色相；符头仅用同色相的明暗渐变，避免「彩虹拼色」感。
 * 相邻琴键色相错开（黄金角），饱和度适中。
 */
function noteColorsForMidi(midi) {
  const n = Math.max(0, Math.min(87, midi - MIDI_MIN));
  const hue = (n * 137.5080469) % 360;
  const s = 46;
  const mid = 52;
  const hi = 64;
  const lo = 40;
  const headHi = `hsl(${hue} ${s}% ${hi}%)`;
  const headMid = `hsl(${hue} ${s}% ${mid}%)`;
  const headLo = `hsl(${hue} ${s}% ${lo}%)`;
  const stem = `hsl(${hue} ${s}% ${mid - 6}%)`;
  return { headHi, headMid, headLo, stem };
}

let _floatNoteGradId = 0;

/** 四分音符：符头为同键单色相近渐变 + 符干同色相 */
function buildFloatingNoteSvg(midi) {
  const { headHi, headMid, headLo, stem } = noteColorsForMidi(midi);
  const gid = `fng${_floatNoteGradId++}`;
  const stemUp = midi < 67;
  const stemW = 3.4;
  const stemStroke = stem;
  if (stemUp) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 86" aria-hidden="true">
      <defs>
        <radialGradient id="${gid}" cx="32%" cy="30%" r="78%">
          <stop offset="0%" stop-color="${headHi}"/>
          <stop offset="52%" stop-color="${headMid}"/>
          <stop offset="100%" stop-color="${headLo}" stop-opacity="0.98"/>
        </radialGradient>
      </defs>
      <line x1="31" y1="12" x2="31" y2="56" stroke="${stemStroke}" stroke-width="${stemW}" stroke-linecap="round" opacity="0.92"/>
      <ellipse cx="21" cy="60" rx="11.2" ry="8.2" fill="url(#${gid})" transform="rotate(-20 21 60)" stroke="rgba(255,255,255,0.32)" stroke-width="0.65"/>
    </svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 86" aria-hidden="true">
    <defs>
      <radialGradient id="${gid}" cx="32%" cy="30%" r="78%">
        <stop offset="0%" stop-color="${headHi}"/>
        <stop offset="52%" stop-color="${headMid}"/>
        <stop offset="100%" stop-color="${headLo}" stop-opacity="0.98"/>
      </radialGradient>
    </defs>
    <line x1="17" y1="36" x2="17" y2="78" stroke="${stemStroke}" stroke-width="${stemW}" stroke-linecap="round" opacity="0.92"/>
    <ellipse cx="24" cy="28" rx="11.2" ry="8.2" fill="url(#${gid})" transform="rotate(-20 24 28)" stroke="rgba(255,255,255,0.32)" stroke-width="0.65"/>
  </svg>`;
}

/**
 * 将 MIDI 音高映射为视觉参数
 * - 飘动高度: 低音 120px → 高音 340px
 * - 气泡大小: 基础 20px → 38px
 * - 色相: 黄金角分布
 */
function _visualParamsFromMidi(midi, velocity) {
  const n = Math.max(0, Math.min(87, midi - 21));
  const vel01 = Math.max(0, Math.min(1, (velocity || 90) / 127));
  const hue = (n * 137.5080469) % 360;
  const floatY = -(120 + (n / 87) * 220); // -120 ~ -340
  const floatDur = 2.0 + (1 - n / 87) * 0.8; // 2.0 ~ 2.8s
  const bubbleSize = 20 + vel01 * 18; // 20 ~ 38px
  const bubbleHeight = -(280 + vel01 * 160); // -280 ~ -440
  const bubbleDur = 1.6 + (1 - vel01) * 0.7; // 1.6 ~ 2.3s
  const colorInner = `hsla(${hue} 70% 65% / 0.42)`;
  const colorMid = `hsla(${hue} 65% 55% / 0.24)`;
  const colorOuter = `hsla(${hue} 60% 50% / 0.08)`;
  const glowColor = `hsla(${hue} 70% 60% / 0.45)`;
  return { floatY, floatDur, bubbleSize, bubbleHeight, bubbleDur, hue, colorInner, colorMid, colorOuter, glowColor, vel01 };
}

/** 原视觉按约束区约 180px 高设计；合一嵌入等矮窗口按比例缩小水泡与摆动 */
const BUBBLE_CONSTRAINT_REF_H = 180;

/**
 * @param {number} constraintHeightPx #constraint-box 可视高度
 * @returns {number} 约 0.26~1
 */
function _bubbleConstraintScale(constraintHeightPx) {
  const h = Math.max(40, Number(constraintHeightPx) || BUBBLE_CONSTRAINT_REF_H);
  return Math.min(1, Math.max(0.26, h / BUBBLE_CONSTRAINT_REF_H));
}

/** 生成音符尾迹粒子 */
function _spawnNoteTrails(container, x, y, params) {
  const count = 5 + Math.floor(params.vel01 * 5);
  for (let i = 0; i < count; i++) {
    const trail = document.createElement("div");
    trail.className = "note-trail";
    const delay = i * 0.12;
    const ty = params.floatY * (0.25 + Math.random() * 0.55);
    const dx = (Math.random() - 0.5) * 40;
    const dur = 0.8 + Math.random() * 0.6;
    const size = 3 + Math.random() * 4;
    trail.style.left = `${x}px`;
    trail.style.top = `${y}px`;
    trail.style.width = `${size}px`;
    trail.style.height = `${size}px`;
    trail.style.background = `radial-gradient(circle, hsla(${params.hue} 70% 70% / 0.7), hsla(${params.hue} 60% 50% / 0.2))`;
    trail.style.boxShadow = `0 0 ${4 + size}px hsla(${params.hue} 70% 60% / 0.35)`;
    trail.style.animationDelay = `${delay}s`;
    trail.style.setProperty("--trail-y", `${ty}px`);
    trail.style.setProperty("--trail-dx", `${dx}px`);
    trail.style.setProperty("--trail-dur", `${dur}s`);
    container.appendChild(trail);
    setTimeout(() => trail.remove(), (delay + dur) * 1000 + 100);
  }
}

/** 生成气泡破裂涟漪 */
function _spawnBubblePop(constraint, x, y, params, scale = 1) {
  const pop = document.createElement("div");
  pop.className = "bubble-pop";
  const sz = Math.max(16, 40 * scale);
  pop.style.width = `${sz}px`;
  pop.style.height = `${sz}px`;
  pop.style.borderWidth = `${Math.max(1, 2.5 * scale)}px`;
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
  pop.style.setProperty("--pop-color", `hsla(${params.hue} 70% 65% / 0.75)`);
  constraint.appendChild(pop);
  setTimeout(() => pop.remove(), 650);
}

/** 生成卫星气泡 */
function _spawnBubbleSatellites(constraint, x, y, params, scale = 1) {
  const satCount = 2 + Math.floor(Math.random() * 3);
  const dot = Math.max(4, 6 * scale);
  for (let i = 0; i < satCount; i++) {
    const sat = document.createElement("div");
    sat.className = "bubble-satellite";
    sat.style.left = `${x}px`;
    sat.style.top = `${y}px`;
    sat.style.width = `${dot}px`;
    sat.style.height = `${dot}px`;
    const r = params.bubbleSize * 0.6 + Math.random() * 10 * scale;
    const dur = params.bubbleDur * (0.7 + Math.random() * 0.5);
    sat.style.setProperty("--sat-r", `${r}px`);
    sat.style.setProperty("--sat-dur", `${dur}s`);
    sat.style.setProperty("--sat-color", `hsla(${params.hue} 65% 60% / 0.5)`);
    constraint.appendChild(sat);
    setTimeout(() => sat.remove(), dur * 1000 + 100);
  }
}

function spawnFloatingStaffNote(clientX, clientY, midi, velocity) {
  // 音符飘动特效已移除，本函数保留为空实现避免调用方报错
  void clientX; void clientY; void midi; void velocity;
}

/**
 * 水泡挂载策略：
 * - unified-single：#musicmol-unified-fx-bubbles（在 .unified-single-exhibition 内，与琴键共用视口坐标差；可越过展陈下缘），飘向展陈上方；
 * - 独立页有约束区：#constraint-box；
 * - 否则：#keyboard-stage 短冒泡。
 */
function spawnKeyBubble(keyEl, midi, velocity) {
  if (!keyEl) return;
  const constraintEl = document.getElementById("constraint-box");
  const stageEl = document.getElementById("keyboard-stage");
  const unifiedFx = document.getElementById("musicmol-unified-fx-bubbles");

  const kr = keyEl.getBoundingClientRect();
  /** @type {"unified-rise"|"constraint"|"keys"} */
  let mode = "keys";
  /** @type {HTMLElement | null} */
  let container = stageEl;

  if (
    unifiedFx &&
    unifiedFx.isConnected &&
    document.documentElement &&
    document.documentElement.classList.contains("unified-single")
  ) {
    mode = "unified-rise";
    container = unifiedFx;
  } else if (constraintEl && constraintEl.isConnected) {
    try {
      const disp = window.getComputedStyle(constraintEl).display;
      const cr0 = constraintEl.getBoundingClientRect();
      if (disp !== "none" && cr0.height >= 36) {
        mode = "constraint";
        container = constraintEl;
      }
    } catch {
      /* */
    }
  }
  if (!container) return;

  const cr = container.getBoundingClientRect();
  const baseX = kr.left + kr.width / 2 - cr.left;

  const raw = _visualParamsFromMidi(midi || 60, velocity);
  let bubbleScale;
  let baseY;
  let params;
  let count;
  let swaySpan = 28;
  let riseKickPx = -28;
  let xSpread = 1.2;
  let yJitter = 12;

  if (mode === "unified-rise") {
    bubbleScale = _bubbleConstraintScale(
      Math.min(560, Math.max(170, window.innerHeight * 0.48))
    );
    baseY = kr.top + kr.height * 0.38 - cr.top;
    const vel01 = Math.max(0, Math.min(1, (velocity || 90) / 127));
    const rise = Math.min(
      680,
      Math.max(220, baseY - 8 - vel01 * 28 - Math.random() * 80)
    );
    params = {
      ...raw,
      bubbleSize: raw.bubbleSize * bubbleScale,
      bubbleHeight: -rise,
      bubbleDur: Math.min(2.65, Math.max(1.45, 1.05 + rise / 320)),
    };
    count = 2 + Math.floor(Math.random() * 3);
    swaySpan = 32;
    riseKickPx = -32 * bubbleScale;
    xSpread = 1.15;
    yJitter = 14;
  } else if (mode === "constraint") {
    bubbleScale = _bubbleConstraintScale(Math.max(40, cr.height));
    baseY = cr.height - 16 * bubbleScale + Math.random() * 12 * bubbleScale;
    params = {
      ...raw,
      bubbleSize: raw.bubbleSize * bubbleScale,
      bubbleHeight: raw.bubbleHeight * bubbleScale,
      bubbleDur: raw.bubbleDur,
    };
    count = 2 + Math.floor(Math.random() * 4);
    riseKickPx = -28 * bubbleScale;
  } else {
    bubbleScale = _bubbleConstraintScale(Math.max(96, kr.height * 5));
    baseY = kr.top + kr.height * 0.38 - cr.top + Math.random() * 8 * bubbleScale;
    const bh = Math.min(-22, Math.max(-88, raw.bubbleHeight * 0.16 * bubbleScale));
    params = {
      ...raw,
      bubbleSize: raw.bubbleSize * bubbleScale * 0.88,
      bubbleHeight: bh,
      bubbleDur: Math.min(1.05, raw.bubbleDur * 0.52),
    };
    count = 1 + Math.floor(Math.random() * 2);
    swaySpan = 14;
    riseKickPx = -18 * bubbleScale * 0.65;
    xSpread = 0.55;
    yJitter = 5;
  }

  const onKeySurface = mode === "keys";

  for (let i = 0; i < count; i++) {
    const bubble = document.createElement("div");
    bubble.className =
      "key-bubble" +
      (onKeySurface ? " key-bubble--on-key" : "") +
      (mode === "unified-rise" ? " key-bubble--unified-rise" : "");

    const swayBase = (Math.random() - 0.5) * swaySpan * bubbleScale;
    const s = bubbleScale;
    bubble.style.setProperty("--sway-1", `${(swayBase + (Math.random() - 0.5) * 10 * s).toFixed(2)}px`);
    bubble.style.setProperty("--sway-1b", `${(swayBase * 0.9 + (Math.random() - 0.5) * 12 * s).toFixed(2)}px`);
    bubble.style.setProperty("--sway-2", `${(swayBase * 0.75 + (Math.random() - 0.5) * 14 * s).toFixed(2)}px`);
    bubble.style.setProperty("--sway-3", `${(swayBase * 0.5 + (Math.random() - 0.5) * 18 * s).toFixed(2)}px`);
    bubble.style.setProperty("--sway-4", `${(swayBase * 0.25 + (Math.random() - 0.5) * 10 * s).toFixed(2)}px`);
    bubble.style.setProperty("--sway-5", `${((Math.random() - 0.5) * 6 * s).toFixed(2)}px`);
    bubble.style.setProperty("--bubble-rise-kick", `${riseKickPx.toFixed(1)}px`);

    const sizeVar = 0.75 + Math.random() * 0.5;
    const durVar = 0.85 + Math.random() * 0.3;
    bubble.style.setProperty("--bubble-size", `${(params.bubbleSize * sizeVar).toFixed(1)}px`);
    bubble.style.setProperty("--bubble-height", `${(params.bubbleHeight * sizeVar).toFixed(1)}px`);
    bubble.style.setProperty("--bubble-dur", `${(params.bubbleDur * durVar).toFixed(2)}s`);
    bubble.style.setProperty("--bubble-color-inner", params.colorInner);
    bubble.style.setProperty("--bubble-color-mid", params.colorMid);
    bubble.style.setProperty("--bubble-color-outer", params.colorOuter);
    bubble.style.setProperty("--bubble-shadow-inset", `hsla(${params.hue} 65% 55% / 0.28)`);
    bubble.style.setProperty("--bubble-shadow-inset2", `hsla(${params.hue} 60% 50% / 0.2)`);
    bubble.style.setProperty("--bubble-shadow-outer", `hsla(${params.hue} 65% 55% / 0.38)`);
    bubble.style.setProperty("--bubble-shadow-outer2", `hsla(${params.hue} 60% 50% / 0.18)`);

    const x = baseX + (Math.random() - 0.5) * kr.width * xSpread * bubbleScale;
    const y = baseY + Math.random() * yJitter * bubbleScale;
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
    if (onKeySurface) bubble.style.zIndex = "32";
    else if (mode === "unified-rise") bubble.style.zIndex = "28";
    container.appendChild(bubble);

    _spawnBubbleSatellites(container, x, y, params, bubbleScale);

    const bubbleDur = params.bubbleDur * durVar;
    const popTimeout = setTimeout(() => {
      _spawnBubblePop(container, x, y + params.bubbleHeight * sizeVar * 0.85, params, bubbleScale);
    }, bubbleDur * 1000 - 300);

    bubble.addEventListener("animationend", () => {
      clearTimeout(popTimeout);
      bubble.remove();
    }, { once: true });
  }
}

/**
 * 收集当前视窗内应绘制的黑键（含左侧跨窗黑键），按 MIDI 去重。
 * centerX 为琴键区域水平坐标（0…1920），落在相邻白键缝隙处。
 */
function gatherBlackPlacements(whiteStart) {
  const slice = WHITE_MIDIS.slice(whiteStart, whiteStart + whiteVisible);
  const whiteW = APP_WIDTH / whiteVisible;
  const seen = new Set();
  const raw = [];

  if (whiteStart > 0) {
    const prev = WHITE_MIDIS[whiteStart - 1];
    const curr = WHITE_MIDIS[whiteStart];
    if (curr - prev === 2) {
      const bm = curr - 1;
      if (bm >= MIDI_MIN && bm <= MIDI_MAX && !seen.has(bm)) {
        seen.add(bm);
        raw.push({ midi: bm, centerX: whiteW * 0.72 });
      }
    }
  }

  slice.forEach((midi, idx) => {
    if (!BLACK_AFTER_PC.has(midi % 12)) return;
    const bm = midi + 1;
    if (bm > MIDI_MAX || seen.has(bm)) return;
    seen.add(bm);
    raw.push({ midi: bm, centerX: (idx + 1) * whiteW });
  });

  return raw;
}

/** 解决平移视窗时黑键理想坐标被挤到同一边导致的重叠 */
function layoutBlackKeys(raw, blackW) {
  const margin = 3;
  if (!raw.length) return [];
  const items = raw
    .map((r) => ({
      midi: r.midi,
      ideal: r.centerX - blackW / 2,
    }))
    .sort((a, b) => a.ideal - b.ideal);

  for (let pass = 0; pass < 5; pass++) {
    items[0].left = Math.max(margin, items[0].ideal);
    for (let i = 1; i < items.length; i++) {
      const minL = items[i - 1].left + blackW + margin;
      items[i].left = Math.max(margin, Math.max(items[i].ideal, minL));
    }
    for (let i = items.length - 2; i >= 0; i--) {
      const maxL = items[i + 1].left - blackW - margin;
      items[i].left = Math.min(items[i].left, maxL);
    }
    for (const it of items) {
      it.left = Math.max(margin, Math.min(APP_WIDTH - blackW - margin, it.left));
    }
  }
  return items;
}

/* ---------- Web Audio ---------- */
let audioCtx = null;
const activeSources = new Map(); // MIDI -> { source, gainNode }

/** Soundfont 加载状态 */
let sfBuffers = null;      // MIDI(21-108) -> AudioBuffer
let sfReady = false;       // 是否已解码完成
let sfLoading = false;     // 是否正在加载

/** 音符名映射：MIDI -> Soundfont Key，如 21 -> "A0", 69 -> "A4" */
const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
function midiToSfKey(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12];
  return name + octave;
}

/**
 * 加载并解码 Soundfont（base64 MP3 内嵌）。
 * 依赖页面先加载 vendor/soundfont/acoustic_grand_piano-mp3.js，
 * 该脚本会创建 window.MIDI.Soundfont.acoustic_grand_piano
 */
async function loadSoundfont() {
  if (sfReady || sfLoading) return;
  sfLoading = true;

  const sfData = window.MIDI?.Soundfont?.acoustic_grand_piano;
  if (!sfData) {
    console.warn("[Soundfont] 未找到 window.MIDI.Soundfont.acoustic_grand_piano，回退到合成器");
    sfLoading = false;
    return;
  }

  const ctx = ensureCtx();
  const jobs = [];
  sfBuffers = new Array(128).fill(null);

  for (let midi = 21; midi <= 108; midi++) {
    const key = midiToSfKey(midi);
    const entry = sfData[key];
    if (!entry) continue;

    jobs.push(
      (async () => {
        try {
          const base64 = entry.split(",")[1];
          if (!base64) return;
          // 严格对齐 xiwnn.com 的 base64 解码方式
          const decodedLen = Math.ceil(3 * base64.length / 4);
          const arrayBuf = new ArrayBuffer(decodedLen);
          const bytes = new Uint8Array(arrayBuf);
          const keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
          let b64clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
          let u = 0, a = 0;
          const oLen = Math.ceil(3 * b64clean.length / 4);
          let h, m, p, f, l, c, d;
          for (u = 0; u < oLen; u += 3) {
            h = keyStr.indexOf(b64clean.charAt(a++));
            m = keyStr.indexOf(b64clean.charAt(a++));
            p = keyStr.indexOf(b64clean.charAt(a++));
            f = keyStr.indexOf(b64clean.charAt(a++));
            l = h << 2 | m >> 4;
            c = (m & 15) << 4 | p >> 2;
            d = (p & 3) << 6 | f;
            bytes[u] = l;
            if (p !== 64) bytes[u + 1] = c;
            if (f !== 64) bytes[u + 2] = d;
          }
          const audioBuf = await ctx.decodeAudioData(arrayBuf);
          sfBuffers[midi] = audioBuf;
        } catch (e) {
          // 单音解码失败不影响其他音
        }
      })()
    );
  }

  await Promise.all(jobs);
  sfReady = true;
  sfLoading = false;
  console.log("[Soundfont] 加载完成，有效采样数:", sfBuffers.filter(Boolean).length);
}

function ensureCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * ISO 16 / 十二平均律，A4(MIDI 69)=440Hz；音高由 MIDI 唯一确定，非随机。
 */
function freqFromMidi(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * 使用 Soundfont 采样播放钢琴音。
 * 若采样未就绪，自动触发加载并回退到合成器。
 */
function playNote(midi, velocity = 0.55, meta) {
  if (window.SoundActivityLogger && typeof window.SoundActivityLogger.logNoteOn === "function") {
    window.SoundActivityLogger.logNoteOn(midi, velocity, meta);
  }

  // 尝试 Soundfont（88键范围内）
  if (midi >= 21 && midi <= 108 && sfReady && sfBuffers && sfBuffers[midi]) {
    _playSoundfontNote(midi, velocity);
    return;
  }

  // 采样未就绪时尝试异步加载（首次）
  if (!sfReady && !sfLoading && midi >= 21 && midi <= 108) {
    loadSoundfont().catch(() => {});
  }

  // 回退：合成器
  _playSynthNote(midi, velocity);
}

/** Soundfont 采样播放（严格对齐 xiwnn.com 做法） */
function _playSoundfontNote(midi, velocity) {
  const ctx = ensureCtx();
  const buf = sfBuffers[midi];
  if (!buf) return;

  // 如果同一音符正在播放，先停止旧音符，避免重叠
  const oldPack = activeSources.get(midi);
  if (oldPack) {
    try {
      if (oldPack.isSf) {
        oldPack.source.stop(ctx.currentTime);
        oldPack.gainNode.disconnect();
      } else {
        oldPack.osc1.stop(ctx.currentTime);
        oldPack.osc2.stop(ctx.currentTime);
        oldPack.master.disconnect();
      }
    } catch {
      /* ignore */
    }
    activeSources.delete(midi);
  }

  const now = ctx.currentTime;

  const source = ctx.createBufferSource();
  source.buffer = buf;

  const gain = ctx.createGain();
  gain.connect(ctx.destination);

  // xiwnn 风格：起始增益为 0，20ms 内 ramp 到固定增益 3
  gain.gain.value = 0;
  source.connect(gain);
  source.start(now);
  gain.gain.linearRampToValueAtTime(3, now + 0.02);

  activeSources.set(midi, { source, gainNode: gain, isSf: true });
}

/** 原有合成器作为 fallback */
function _playSynthNote(midi, velocity) {
  const ctx = ensureCtx();

  // 如果同一音符正在播放，先停止旧音符，避免重叠
  const oldPack = activeSources.get(midi);
  if (oldPack) {
    try {
      if (oldPack.isSf) {
        oldPack.source.stop(ctx.currentTime);
        oldPack.gainNode.disconnect();
      } else {
        oldPack.osc1.stop(ctx.currentTime);
        oldPack.osc2.stop(ctx.currentTime);
        oldPack.master.disconnect();
      }
    } catch {
      /* ignore */
    }
    activeSources.delete(midi);
  }

  const now = ctx.currentTime;
  const freq = freqFromMidi(midi);

  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const osc1 = ctx.createOscillator();
  osc1.type = "triangle";
  osc1.frequency.value = freq;

  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = freq * 2;

  const g1 = ctx.createGain();
  const g2 = ctx.createGain();
  g1.gain.value = velocity * 0.55;
  g2.gain.value = velocity * 0.22;

  osc1.connect(g1);
  osc2.connect(g2);
  g1.connect(master);
  g2.connect(master);

  const attack = 0.002;
  const decay = 0.08;
  const sustain = velocity * 0.35;
  const release = 0.32;

  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(velocity, now + attack);
  master.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.001), now + attack + decay);

  osc1.start(now);
  osc2.start(now);

  activeSources.set(midi, { master, osc1, osc2, isSf: false });
}

function stopNote(midi) {
  const pack = activeSources.get(midi);
  if (!pack) return;

  const ctx = ensureCtx();
  const now = ctx.currentTime;

  if (pack.isSf) {
    // Soundfont 释放：严格对齐 xiwnn.com 做法
    // noteOff: gain.linearRampToValueAtTime(gain.value, currentTime)
    //          gain.linearRampToValueAtTime(0, currentTime + 0.1 + endGradualTime)
    //          setTimeout(() => n.disconnect(), (0.11 + endGradualTime) * 1000)
    const { source, gainNode } = pack;
    const endGradualTime = 0.5;
    try {
      gainNode.gain.linearRampToValueAtTime(gainNode.gain.value, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.1 + endGradualTime);
    } catch {
      /* ignore */
    }
    activeSources.delete(midi);
    setTimeout(() => {
      try {
        source.disconnect();
        gainNode.disconnect();
      } catch {
        /* ignore */
      }
    }, (0.11 + endGradualTime) * 1000);
  } else {
    // 合成器释放
    const { master, osc1, osc2 } = pack;
    const release = 0.22;
    try {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.exponentialRampToValueAtTime(0.0008, now + release);
      osc1.stop(now + release + 0.02);
      osc2.stop(now + release + 0.02);
    } catch {
      /* ignore */
    }
    activeSources.delete(midi);
    setTimeout(() => {
      try {
        master.disconnect();
      } catch {
        /* ignore */
      }
    }, (release + 0.1) * 1000);
  }
}

/* ---------- 大屏同步：钢琴交互模式 ---------- */
/** @type {"music_to_molecule"|"molecule_to_music"} */
let pianoInteractionMode = "music_to_molecule";

function isPianoGloballyLocked() {
  return pianoInteractionMode === "molecule_to_music";
}

let _modeLockToastUntil = 0;

function showModeLockToast() {
  const now = Date.now();
  if (now < _modeLockToastUntil) return;
  _modeLockToastUntil = now + 2000;
  expandUnifiedDockIfCollapsed();
  const el = document.getElementById("molecule-toast");
  if (!el) return;
  el.textContent =
    "分子生成音乐中，请稍后。请在大屏将模式切换为「音乐生成分子」后即可演奏。 / Please switch the big screen to “Music → Molecule” mode to play.";
  el.hidden = false;
  clearTimeout(showModeLockToast._t);
  showModeLockToast._t = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

/**
 * 合一单页底栏收合时 #app 离屏不可点；模式锁定横幅仍在 #app 内，故弹出前临时展开以便看见提示。
 */
function expandUnifiedDockIfCollapsed() {
  try {
    const html = document.documentElement;
    if (!html.classList.contains("unified-single")) return;
    if (!html.classList.contains("unified-piano-dock-collapsed")) return;
    html.classList.remove("unified-piano-dock-collapsed");
    try {
      sessionStorage.setItem("unifiedPianoDockCollapsed", "0");
    } catch {
      /* ignore */
    }
    const exp = document.getElementById("unified-piano-dock-expand");
    if (exp) exp.setAttribute("aria-expanded", "true");
    window.dispatchEvent(new Event("musicmol-unified-dock-layout"));
  } catch {
    /* ignore */
  }
}

/** 大屏通过 POST /api/piano_interaction_mode 切换模式时，轮询发现与本地不一致则调用：收起「重新弹奏」横幅、清录音/点歌暂存等，无需用户再点「重新弹奏」。 */
function resetUiAfterRemotePianoModeSwitch() {
  endManualDrag(null);
  touchReleaseCurrent();
  touchDragPointerId = null;
  resetMinimapMoleculePanel();
  const extPr = document.getElementById("minimap-external-prompt");
  if (extPr) {
    extPr.hidden = true;
    delete extPr.dataset.eventsJson;
  }
  syncMinimapWrapPromptOpen();
  pendingMolMusicUiKey = null;
  pendingPromptSource = null;
  _pendingDemoSongKey = null;
  _pendingDemoSongSeq = null;
  _pendingDemoSongInferred = false;
  clearUserRecording();
  moleculeToast.hidden = true;
  resetMoleculeToastPanel();
  cancelAutoSong();
  setAutoMode(false);
  closeSongOverlay();
  closeScoreOverlay();
  for (const m of [...activeSources.keys()]) {
    stopNote(m);
  }
  document.querySelectorAll(".white-key.active, .black-key.active").forEach((el) => {
    el.classList.remove("active");
  });
}

function applyPianoInteractionModeFromServer(mode) {
  const prev = pianoInteractionMode;
  const next = mode === "molecule_to_music" ? "molecule_to_music" : "music_to_molecule";
  const modeChanged = prev !== next;
  if (modeChanged) {
    resetUiAfterRemotePianoModeSwitch();
  }
  pianoInteractionMode = next;
  const appEl = document.getElementById("app");
  if (appEl) appEl.classList.toggle("is-piano-mode-locked", isPianoGloballyLocked());
  const zh = document.getElementById("status-zh");
  const en = document.getElementById("status-en");
  if (zh && en) {
    if (pianoInteractionMode === "molecule_to_music") {
      zh.textContent = "模式：分子生成音乐";
      en.textContent = "Mode: Molecule → Music";
    } else {
      zh.textContent = "模式：音乐生成分子";
      en.textContent = "Mode: Music → Molecule";
    }
  }
  updateSongPickButtonLock();
}

/** 点歌后暂存的歌曲数据，供演奏结束后手动生成分子使用 */
let _pendingDemoSongKey = null;
let _pendingDemoSongSeq = null;
let _pendingDemoSongInferred = false;

async function syncPianoInteractionMode() {
  if (isPainojsUnifiedSingleSameDocument()) {
    try {
      const sp = new URLSearchParams(typeof location !== "undefined" && location.search ? location.search : "");
      let r = String(sp.get("route") || "")
        .trim()
        .toLowerCase();
      if (!r && typeof location !== "undefined" && location.hash) {
        const hm = String(location.hash || "").match(/route[-/](music2mol|m2mol|mol2music|m2m|full)\b/i);
        if (hm) r = String(hm[1] || "").toLowerCase();
      }
      if (r === "mol2music" || r === "m2m") {
        applyPianoInteractionModeFromServer("molecule_to_music");
      } else if (r === "music2mol" || r === "m2mol") {
        applyPianoInteractionModeFromServer("music_to_molecule");
      }
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const resp = await fetch(`${API_BASE}/api/piano_interaction_mode`, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });
    const d = await resp.json();
    if (resp.ok && d.ok && d.mode) {
      applyPianoInteractionModeFromServer(d.mode);
    }
  } catch {
    /* ignore */
  }
}

/* ---------- 用户弹奏录音（用于五线谱与 MIDI） ---------- */
/** @type {{ midi: number, startMs: number, endMs: number }[]} */
const userPerformance = [];
/** 支持同音连击：每个 MIDI 一组 onset 时间戳 */
const recordOnsetStacks = new Map();
let perfOriginMs = null;
let previewPlaybackId = 0;

function cancelPreviewPlayback() {
  previewPlaybackId += 1;
  // 停止所有正在播放的预览音符，避免声音残留
  for (const m of [...activeSources.keys()]) {
    stopNote(m);
  }
  document.querySelectorAll(".white-key.active, .black-key.active").forEach((el) => {
    el.classList.remove("active");
  });
}

function recordUserNoteOn(midi) {
  if (perfOriginMs === null) perfOriginMs = performance.now();
  let s = recordOnsetStacks.get(midi);
  if (!s) {
    s = [];
    recordOnsetStacks.set(midi, s);
  }
  s.push(performance.now());
}

function recordUserNoteOff(midi) {
  if (perfOriginMs === null) return;
  const s = recordOnsetStacks.get(midi);
  if (!s || !s.length) return;
  const t0 = s.pop();
  if (s.length === 0) recordOnsetStacks.delete(midi);
  const t1 = performance.now();
  userPerformance.push({
    midi,
    startMs: t0 - perfOriginMs,
    endMs: t1 - perfOriginMs,
  });
  updateSongPickButtonLock();
}

/** 每键一次：上报到 MusicMol :5020，由后端再 POST 至外设 glass_session（映射端为跨域，须明确 cors）。 */
function postRealtimeMidiOutbound(type, note, velocity) {
  if (isPainojsUnifiedSingleSameDocument()) return;
  const body = JSON.stringify({
    type,
    note,
    velocity: Math.max(0, Math.min(127, velocity | 0)),
    timestamp_ms: Date.now(),
  });
  fetch(`${API_BASE}/api/outbound/realtime_midi`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

/** 用户按键释放时，直接向 8082 POST /__push/glass_session（full 形态，smiles 占位） */
function postRealtimeMidiToGlassSession(note, startMs, durationMs, bpm = 120) {
  const events = [{
    note,
    start: Math.round(startMs),
    duration: Math.round(Math.max(1, durationMs)),
  }];
  const body = { smiles: "pending", bpm, reveal_last_sec: 5, events };
  const url = `${getOutbound8082Base()}/__push/glass_session`;
  void fetch(url, {
    ...FETCH_OUTBOUND8082_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function clearUserRecording() {
  userPerformance.length = 0;
  perfOriginMs = null;
  recordOnsetStacks.clear();
  cancelPreviewPlayback();
  updateSongPickButtonLock();
}

/**
 * 「音乐生成分子」模式：有未「生成分子」的弹奏记录，或点歌演奏尚未完成推理时，禁止点歌。
 */
function updateSongPickButtonLock() {
  const btn = document.getElementById("btn-song");
  if (!btn) return;
  let block = false;
  if (pianoInteractionMode === "music_to_molecule") {
    if (userPerformance.length > 0) block = true;
    if (_pendingDemoSongKey && _pendingDemoSongSeq && !_pendingDemoSongInferred) block = true;
  }
  btn.disabled = block;
  /* 与「收起 / 重置」一致：始终 secondary + text-btn；勿在锁定时剥掉 text-btn（会破坏合一顶栏统一高度）或改成主色绿条 */
  btn.classList.add("text-btn", "text-btn-secondary", "bilingual-tb");
  btn.title = block
    ? "请先「生成分子」后再点歌 / Tap “Molecule” to generate first"
    : "点歌 / Pick a demo song";
}

function writeMidiVarInt(n, out) {
  let v = n >>> 0;
  const stack = [];
  stack.push(v & 0x7f);
  v >>>= 7;
  while (v) {
    stack.push(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  while (stack.length) out.push(stack.pop());
}

function msToMidiTick(ms, bpm, ppq) {
  return Math.round((ms * bpm * ppq) / 60000);
}

/** 生成标准 MIDI 0 型单轨文件（十二平均律音高由 MIDI 号表达） */
function buildMidiFile(events, bpm = 120, ppq = 480) {
  const usPerQuarter = Math.round(60000000 / bpm);
  const track = [];
  track.push(0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);

  const list = [];
  for (const e of events) {
    list.push({ t: e.startMs, on: 1, m: e.midi });
    list.push({ t: e.endMs, on: 0, m: e.midi });
  }
  list.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    return a.on - b.on;
  });

  let prevTick = 0;
  for (const ev of list) {
    const tick = msToMidiTick(ev.t, bpm, ppq);
    let delta = tick - prevTick;
    if (delta < 0) delta = 0;
    prevTick = tick;
    writeMidiVarInt(delta, track);
    if (ev.on) track.push(0x90, ev.m, 0x67);
    else track.push(0x80, ev.m, 0x40);
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const trackLen = track.length;
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, (ppq >> 8) & 0xff, ppq & 0xff,
    0x4d, 0x54, 0x72, 0x6b, (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff,
  ];
  return new Uint8Array([...header, ...track]);
}

function scoreNoteCy(midi) {
  const y = staffYForMidi(midi);
  return 18 + ((y - 10) / 62) * 52;
}

function renderScoreInto(container) {
  if (!userPerformance.length) {
    container.innerHTML =
      '<div class="score-empty">暂无弹奏记录 / No notes recorded<br/><small>请先弹奏钢琴后再生成 / Play the piano first</small></div>';
    return;
  }
  const sorted = [...userPerformance].sort((a, b) => a.startMs - b.startMs);
  const pxPerMs = 0.18;
  const padL = 64;
  const padR = 56;
  const maxT = Math.max(...sorted.map((e) => e.endMs), 0);
  const W = Math.max(520, Math.ceil(padL + maxT * pxPerMs + padR));
  const H = 128;
  const staffYs = [34, 44, 54, 64, 74];
  const lines = staffYs
    .map(
      (y) =>
        `<line x1="${padL - 14}" x2="${W - padR + 14}" y1="${y}" y2="${y}" stroke="#ffffff" stroke-width="1.35" stroke-opacity="0.95" stroke-linecap="round"/>`
    )
    .join("");
  const clefTreble = `<text x="6" y="78" font-size="36" fill="#ffffff" font-family="'Segoe UI Symbol',serif">𝄞</text>`;
  const parts = [lines, clefTreble];
  for (const ev of sorted) {
    const cx = padL + ev.startMs * pxPerMs + 10;
    const cy = Math.max(20, Math.min(96, scoreNoteCy(ev.midi) + 8));
    const sharp = [1, 3, 6, 8, 10].includes(ev.midi % 12);
    if (sharp) {
      parts.push(
        `<text x="${cx - 14}" y="${cy + 5}" font-size="14" fill="#ffffff" text-anchor="middle" font-family="serif">♯</text>`
      );
    }
    const stemUp = ev.midi < 67;
    const sx = stemUp ? cx - 5 : cx + 7;
    const y1 = stemUp ? cy - 22 : cy + 2;
    const y2 = stemUp ? cy + 2 : cy + 24;
    parts.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="5.5" ry="3.8" fill="#ffffff" transform="rotate(-16 ${cx} ${cy})"/>` +
        `<line x1="${sx}" y1="${y1}" x2="${sx}" y2="${y2}" stroke="#ffffff" stroke-width="1.35" stroke-linecap="round"/>`
    );
  }
  container.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="score-svg-white">${parts.join("")}</svg>`;
}

function openScoreOverlay() {
  cancelPreviewPlayback();
  const ov = document.getElementById("score-overlay");
  const sheet = document.getElementById("score-sheet");
  if (!ov || !sheet) return;
  renderScoreInto(sheet);
  ov.hidden = false;
  ov.setAttribute("aria-hidden", "false");
}

function closeScoreOverlay() {
  cancelPreviewPlayback();
  const ov = document.getElementById("score-overlay");
  if (ov) {
    ov.hidden = true;
    ov.setAttribute("aria-hidden", "true");
  }
}

function previewRecording() {
  ensureCtx();
  cancelPreviewPlayback();
  if (!userPerformance.length) return;
  const job = previewPlaybackId;
  const sorted = [...userPerformance].sort((a, b) => a.startMs - b.startMs);
  for (const ev of sorted) {
    setTimeout(() => {
      if (job !== previewPlaybackId) return;
      const keyEl = keyboardEl.querySelector(`[data-midi="${ev.midi}"]`);
      flashKeyVisual(ev.midi, true);
      spawnKeyBubble(keyEl, ev.midi, 0.55 * 127);
      playNote(ev.midi, 0.55, { source: "score_preview" });
    }, ev.startMs);
    setTimeout(() => {
      if (job !== previewPlaybackId) return;
      flashKeyVisual(ev.midi, false);
      stopNote(ev.midi);
    }, ev.endMs);
  }
}

function resetMoleculeToastPanel() {
  if (!moleculeToast) return;
  moleculeToast.classList.remove("molecule-toast--panel");
  moleculeToast.innerHTML = "";
}

/** 顶栏 minimap 上「生成分子」横幅：与外部 MIDI 提示共用 overflow 类 */
function syncMinimapWrapPromptOpen() {
  const mw = document.getElementById("minimap-wrap");
  const ext = document.getElementById("minimap-external-prompt");
  const mol = document.getElementById("minimap-molecule-panel");
  if (!mw) return;
  const extOn = ext && !ext.hidden;
  const molOn = mol && !mol.hidden;
  mw.classList.toggle("minimap-wrap--prompt-open", !!(extOn || molOn));
}

function minimapMoleculePanelLocksKeys() {
  const p = document.getElementById("minimap-molecule-panel");
  return !!(p && !p.hidden);
}

function updateMoleculeKeyboardLock() {
  const stage = document.getElementById("keyboard-stage");
  if (stage) stage.classList.toggle("is-molecule-banner-lock", minimapMoleculePanelLocksKeys());
}

function resetMinimapMoleculePanel() {
  const panel = document.getElementById("minimap-molecule-panel");
  const inner = document.getElementById("minimap-molecule-inner");
  if (inner) inner.innerHTML = "";
  if (panel) {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
  }
  syncMinimapWrapPromptOpen();
  updateMoleculeKeyboardLock();
}

function openMinimapMoleculePanel(html) {
  const panel = document.getElementById("minimap-molecule-panel");
  const inner = document.getElementById("minimap-molecule-inner");
  if (!panel || !inner) return;
  inner.innerHTML = html;
  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");
  syncMinimapWrapPromptOpen();
  updateMoleculeKeyboardLock();
}

/** 生成分子成功：点「重新弹奏」仅关闭横幅并解锁键盘，不打开点歌菜单 */
function attachMinimapMoleculeBannerListeners() {
  const btnSong = document.getElementById("mol-banner-new-song");
  btnSong?.addEventListener(
    "click",
    () => {
      if (isPianoGloballyLocked()) {
        showModeLockToast();
        return;
      }
      resetMinimapMoleculePanel();
      closeScoreOverlay();
      _pendingDemoSongKey = null;
      _pendingDemoSongSeq = null;
      _pendingDemoSongInferred = false;
      updateSongPickButtonLock();
    },
    { once: true }
  );
}

/** 推理失败或网络错误时通知最顶层父页，收起「钢琴演奏中」副标题（与 glass / app.js 联动）。 */
function clearMusic2molParentPlayingSubtitle() {
  try {
    if (typeof window !== "undefined" && window.top && window.top !== window) {
      window.top.postMessage({ type: "glass-molecule:music2mol-subtitle-clear" }, "*");
    }
  } catch (_) {
    /* 跨域或 sandbox 时忽略 */
  }
}

/** 钢琴演奏→分子推理可能长达数分钟（CPU）；超时后中止请求并提示用户缩短演奏 */
const MUSIC_M2M_FETCH_TIMEOUT_MS = 240000;

/** PAINOJS :8766 等映射端跨域访问 :5020 推理接口；非 JSON 响应时给出可读错误 */
async function fetchInferenceJson(url, init = {}) {
  const rest = { ...init };
  const timeoutMs =
    typeof rest.__timeoutMs === "number" && rest.__timeoutMs > 0
      ? rest.__timeoutMs
      : MUSIC_M2M_FETCH_TIMEOUT_MS;
  delete rest.__timeoutMs;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, {
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      ...rest,
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    if (e && e.name === "AbortError") {
      return {
        resp: null,
        data: {
          ok: false,
          error:
            "推理超时（请缩短弹奏片段或稍后重试） / Inference timed out — try a shorter performance",
        },
      };
    }
    throw e;
  }
  clearTimeout(tid);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const data = await r.json();
      return { resp: r, data };
    } catch {
      return { resp: r, data: { ok: false, error: "响应不是合法 JSON" } };
    }
  }
  let text = "";
  try {
    text = (await r.text()).slice(0, 240);
  } catch {
    text = "";
  }
  return { resp: r, data: { ok: false, error: text || `HTTP ${r.status}` } };
}

/** 根据当前 userPerformance 走推理；成功后仅在请求中带 push_outbound_smiles 时由后端向 8082 __push/smiles 外发 SMILES。不再调用 molecule_submit，避免本页轮询出现「在大屏钢琴上演奏」二次提示。提示 UI 在顶栏钢琴拖动条（minimap）区域展示。 */
async function runMoleculeInferenceFromPerformance() {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  if (!userPerformance.length) {
    openMinimapMoleculePanel(
      `<div class="minimap-mol-one-line">没有弹奏记录 <span class="minimap-mol-sep">·</span> <span class="en">Nothing to send</span></div>`
    );
    setTimeout(() => resetMinimapMoleculePanel(), 2400);
    return;
  }
  closeScoreOverlay();
  resetMinimapMoleculePanel();
  openMinimapMoleculePanel(
    `<div class="minimap-mol-loading-row"><span class="minimap-mol-loading-label">AI 生成分子中 <span class="minimap-mol-sep">·</span> <span class="en">Running…</span></span><div class="minimap-mol-loading-bar" aria-hidden="true"></div></div>`
  );
  const events = userPerformance.map((e) => ({
    note: e.midi,
    start: Math.max(0, Math.round(e.startMs)),
    duration: Math.max(40, Math.round(e.endMs - e.startMs)),
  }));
  const bpm = 120;
  let data = null;
  try {
    const midiBytes = buildMidiFile(
      userPerformance.map((e) => ({
        midi: e.midi,
        startMs: e.startMs,
        endMs: e.endMs,
      })),
      bpm,
      480
    );
    const fd = new FormData();
    fd.append("midi", new Blob([midiBytes], { type: "audio/midi" }), "live_capture.mid");
    fd.append("bpm", String(bpm));
    let r = await fetchInferenceJson(`${API_BASE}/api/music_to_molecule_midi`, {
      method: "POST",
      body: fd,
    });
    data = r.data;
    if (!data.ok) {
      r = await fetchInferenceJson(`${API_BASE}/api/music_to_molecule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, bpm }),
      });
      data = r.data;
    }
    if (data.ok && data.best_smiles) {
      showConfetti();
      const sm = escapeHtml(data.best_smiles);
      const smTitle = escapeHtml(
        `请观看大屏幕查看分子 · Watch main display · SMILES: ${data.best_smiles}`
      );
      openMinimapMoleculePanel(
        `<div class="minimap-mol-done-row">
  <span class="minimap-mol-done-mark" aria-hidden="true">✓</span>
  <div class="minimap-mol-smiles-line" title="${smTitle}">${sm}</div>
  <button type="button" class="text-btn bilingual-tb minimap-mol-cta" id="mol-banner-new-song"><span class="bilingual-tb-inner"><span class="zh">重新弹奏</span><span class="sep">/</span><span class="en">New song</span></span></button>
</div>`
      );
      attachMinimapMoleculeBannerListeners();
      // 用户演奏推理成功后，向 8082 发送 smiles 形态
      postGlassSession(null, null, data.best_smiles, data.meta || null, "smiles");
      if (typeof globalThis.receiveSmilesAndDisplay === 'function') {
        globalThis.receiveSmilesAndDisplay(data.best_smiles, { skipMainScene: false });
      }
    } else {
      clearMusic2molParentPlayingSubtitle();
      const errRaw = String(data.error || "unknown");
      const err = escapeHtml(errRaw);
      const errTitle = escapeHtml(errRaw);
      openMinimapMoleculePanel(
        `<div class="minimap-mol-one-line" title="${errTitle}"><span class="zh">失败</span><span class="minimap-mol-sep">·</span><span class="en">Failed</span><span class="minimap-mol-sep">·</span><span class="minimap-mol-err-body">${err}</span></div>`
      );
      setTimeout(() => resetMinimapMoleculePanel(), 4500);
    }
  } catch (err) {
    clearMusic2molParentPlayingSubtitle();
    openMinimapMoleculePanel(
      `<div class="minimap-mol-one-line" title="请检查网络后重试 / Check connection">网络错误<span class="minimap-mol-sep">·</span><span class="en">Network error</span><span class="minimap-mol-sep">·</span><span class="minimap-mol-err-body">请检查连接</span></div>`
    );
    setTimeout(() => resetMinimapMoleculePanel(), 4000);
  }
  clearUserRecording();
}

/**
 * 点歌演奏结束后，用户点击「生成分子」时执行的 AI 推理。
 * 复用原先 song-play 中的推理逻辑，成功后外发 SMILES 并解锁点歌按钮。
 */
async function runMoleculeInferenceForDemoSong() {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  if (!_pendingDemoSongKey || !_pendingDemoSongSeq) return;
  if (_pendingDemoSongInferred) return;

  const seq = _pendingDemoSongSeq;
  const bpm = 100;
  const evsForInference = seq.map((e) => ({
    note: e.midi,
    start: Math.round(e.startMs),
    duration: Math.round(Math.max(40, e.endMs - e.startMs)),
  }));

  openMinimapMoleculePanel(
    `<div class="minimap-mol-loading-row"><span class="minimap-mol-loading-label">AI 生成分子中 <span class="minimap-mol-sep">·</span> <span class="en">Running…</span></span><div class="minimap-mol-loading-bar" aria-hidden="true"></div></div>`
  );

  let inferredSmiles = "";
  let inferredMeta = null;
  let inferenceError = "";
  try {
    const midiBytes = buildMidiFile(
      seq.map((e) => ({ midi: e.midi, startMs: e.startMs, endMs: e.endMs })),
      bpm,
      480
    );
    const fd = new FormData();
    fd.append("midi", new Blob([midiBytes], { type: "audio/midi" }), "demo_song.mid");
    fd.append("bpm", String(bpm));
    let r = await fetchInferenceJson(`${API_BASE}/api/music_to_molecule_midi`, {
      method: "POST",
      body: fd,
    });
    let data = r.data;
    if (!data.ok) {
      r = await fetchInferenceJson(`${API_BASE}/api/music_to_molecule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: evsForInference, bpm }),
      });
      data = r.data;
    }
    if (data.ok && data.best_smiles) {
      inferredSmiles = data.best_smiles;
      inferredMeta = data.meta || null;
      if (typeof globalThis.receiveSmilesAndDisplay === 'function') {
        globalThis.receiveSmilesAndDisplay(data.best_smiles, { skipMainScene: false });
      }
    } else {
      inferenceError = String(data.error || "模型未返回有效 SMILES");
    }
  } catch (err) {
    inferenceError = String(err.message || err || "网络或服务器错误");
  }

  if (!inferredSmiles) {
    clearMusic2molParentPlayingSubtitle();
    openMinimapMoleculePanel(
      `<div class="minimap-mol-one-line" title="${escapeHtml(inferenceError)}"><span class="zh">模型推理失败</span><span class="minimap-mol-sep">·</span><span class="en">Inference failed</span><span class="minimap-mol-sep">·</span><span class="minimap-mol-err-body">${escapeHtml(inferenceError)}</span></div>`
    );
    setTimeout(() => resetMinimapMoleculePanel(), 5000);
    updateSongPickButtonLock();
    return;
  }

  // 推理成功
  _pendingDemoSongInferred = true;
  showConfetti();
  const sm = escapeHtml(inferredSmiles);
  const smTitle = escapeHtml(
    `请观看大屏幕查看分子 · Watch main display · SMILES: ${inferredSmiles}`
  );
  openMinimapMoleculePanel(
    `<div class="minimap-mol-done-row">
  <span class="minimap-mol-done-mark" aria-hidden="true">✓</span>
  <div class="minimap-mol-smiles-line" title="${smTitle}">${sm}</div>
  <button type="button" class="text-btn bilingual-tb minimap-mol-cta" id="mol-banner-new-song"><span class="bilingual-tb-inner"><span class="zh">重新弹奏</span><span class="sep">/</span><span class="en">New song</span></span></button>
</div>`
  );
  attachMinimapMoleculeBannerListeners();
  postGlassSessionForDemoSong(_pendingDemoSongKey, seq, inferredSmiles, inferredMeta, "smiles");

  // 清除暂存（用户可继续弹奏）
  _pendingDemoSongKey = null;
  _pendingDemoSongSeq = null;
  updateSongPickButtonLock();
}

async function confirmSendRecording() {
  await runMoleculeInferenceFromPerformance();
}

function showAiProgress(text) {
  const host = document.getElementById("ai-progress-slot");
  if (!host) return;
  host.innerHTML = `<div class="ai-progress" id="ai-progress"><div class="ai-progress-inner"><div class="ai-progress-bar"></div><div class="ai-progress-text"></div></div></div>`;
  const bar = host.querySelector(".ai-progress-text");
  if (bar) bar.textContent = text;
  host.hidden = false;
}

function hideAiProgress() {
  const host = document.getElementById("ai-progress-slot");
  if (host) {
    host.hidden = true;
    host.innerHTML = "";
  }
}

function showConfetti() {
  const layer = document.getElementById("fx-layer");
  if (!layer) return;
  const colors = ["#ff5252", "#448aff", "#69f0ae", "#ffd740", "#ff4081", "#18ffff", "#e040fb", "#ffff00"];
  const stage = document.getElementById("keyboard-stage");
  const sr = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: 1920, height: 200 };
  const lr = layer.getBoundingClientRect();
  const cx = sr.left + sr.width / 2 - lr.left;
  const cy = sr.top + sr.height * 0.35 - lr.top;
  for (let i = 0; i < 110; i++) {
    const el = document.createElement("div");
    el.className = "confetti-piece";
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.style.width = `${4 + Math.random() * 5}px`;
    el.style.height = `${4 + Math.random() * 5}px`;
    el.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.pointerEvents = "none";
    el.style.zIndex = "40";
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 220;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 80 - Math.random() * 120;
    const rot = (Math.random() - 0.5) * 720;
    el.style.transition = "transform 1.1s cubic-bezier(0.22,1,0.36,1), opacity 1.1s ease";
    layer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(0.2)`;
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 1150);
  }
}

/* ---------- UI state ---------- */
let whiteStart = 0;

const keyboardEl = document.getElementById("keyboard");
const keyboardStage = document.getElementById("keyboard-stage");
const minimapEl = document.getElementById("minimap");
const minimapViewport = document.getElementById("minimap-viewport");
const minimapWrap = document.getElementById("minimap-wrap");
const moleculeToast = document.getElementById("molecule-toast");

/** 自动演奏：默认手动；点歌或接口 MIDI 确认后进入 */
let isAutoMode = false;
let songJobId = 0;
let selectedSongKey = null;
let pendingMolMusicUiKey = null;
let pendingPromptSource = null;

function cancelAutoSong() {
  songJobId += 1;
  // 停止所有正在播放的自动播放音符，避免声音残留
  for (const m of [...activeSources.keys()]) {
    stopNote(m);
  }
  document.querySelectorAll(".white-key.active, .black-key.active").forEach((el) => {
    el.classList.remove("active");
  });
}

function setAutoMode(on) {
  isAutoMode = !!on;
  const stage = document.getElementById("keyboard-stage");
  if (stage) stage.classList.toggle("is-auto-mode", isAutoMode);
  updateAutoModeHint();
}

function updateAutoModeHint() {
  const hint = document.getElementById("auto-mode-hint");
  if (!hint) return;
  if (isAutoMode) {
    hint.hidden = false;
    hint.innerHTML =
      "<span>自动演奏中，键盘锁定 / Auto playback, keys locked</span><br/><small>结束后可手动弹奏 / Manual play resumes when finished</small>";
  } else {
    hint.hidden = true;
  }
}

function flashKeyVisual(midi, on) {
  const el = keyboardEl.querySelector(`[data-midi="${midi}"]`);
  if (!el) return;
  el.classList.toggle("active", !!on);
}

function spawnStaffForMidi(midi) {
  const el = keyboardEl.querySelector(`[data-midi="${midi}"]`);
  const constraint = document.getElementById("constraint-box");
  if (el && constraint) {
    const er = el.getBoundingClientRect();
    const cr = constraint.getBoundingClientRect();
    const x = er.left + er.width / 2;
    const y = cr.bottom - 30;
    spawnFloatingStaffNote(x, y, midi, 90);
    return;
  }
  spawnDemoStaffAtCenter(midi);
}

function spawnDemoStaffAtCenter(midi) {
  const constraint = document.getElementById("constraint-box");
  if (!constraint) return;
  const cr = constraint.getBoundingClientRect();
  spawnFloatingStaffNote(cr.left + cr.width * 0.5, cr.bottom - 30, midi, 90);
}

function normalizePlayEvent(ev) {
  const note = ev.note != null ? ev.note : ev.midi;
  const time = ev.time != null ? ev.time : ev.start != null ? ev.start : ev.startMs;
  let duration = ev.duration;
  if (duration == null && ev.startMs != null && ev.endMs != null) {
    duration = Math.max(40, ev.endMs - ev.startMs);
  }
  duration = duration != null ? duration : 200;
  const velocity = ev.velocity != null ? ev.velocity : 90;
  return { note, time, duration, velocity };
}

function enterAutoPlayFromMidiEvents(rawEvents, autoplaySource = "autoplay") {
  /* 不在此处拦截 locked：分子→音乐模式下需播放服务端 pending；用户手动点歌等入口已单独拦截 */
  if (!rawEvents || !rawEvents.length) return;
  const midiEvents = rawEvents.map(normalizePlayEvent).sort((a, b) => a.time - b.time);
  if (window.SoundActivityLogger && typeof window.SoundActivityLogger.log === "function") {
    window.SoundActivityLogger.log("autoplay_start", { source: autoplaySource, note_count: midiEvents.length });
  }
  setAutoMode(true);
  cancelAutoSong();
  const job = songJobId;
  midiEvents.forEach((ev) => {
    const startAt = ev.time;
    setTimeout(() => {
      if (job !== songJobId) return;
      const keyEl = keyboardEl.querySelector(`[data-midi="${ev.note}"]`);
      flashKeyVisual(ev.note, true);
      spawnKeyBubble(keyEl, ev.note, ev.velocity || 90);
      playNote(ev.note, (ev.velocity || 90) / 127, { source: autoplaySource });
      setTimeout(() => {
        if (job !== songJobId) return;
        flashKeyVisual(ev.note, false);
        stopNote(ev.note);
      }, Math.max(80, ev.duration));
    }, startAt);
  });
  const last = midiEvents[midiEvents.length - 1];
  const total = (last ? last.time + last.duration : 0) + 900;
  setTimeout(() => {
    if (job !== songJobId) return;
    setAutoMode(false);
    // 点歌演奏结束：提示用户点击「生成分子」
    if (_pendingDemoSongKey && _pendingDemoSongSeq) {
      moleculeToast.innerHTML = '<span>演奏结束，点击「生成分子」生成对应分子 / Finished — tap "Molecule" to infer</span>';
    } else {
      moleculeToast.textContent = "演奏结束，可手动弹奏 / Finished — you can play manually";
    }
    moleculeToast.hidden = false;
    setTimeout(() => {
      moleculeToast.hidden = true;
    }, 4200);
    // 上报「演奏结束」
    if (_currentMoleculeSessionId) {
      postManualMoleculeMusicPhase(_currentMoleculeSessionId, "finished");
      _currentMoleculeSessionId = null;
    }
  }, total);
}

/** 样例药物详情「播放分子音乐」：在 POST molecule_submit 后由展陈派发，底栏立即本地演奏（不依赖 5020/8082 是否已桥接 pending）。 */
try {
  window.addEventListener("musicmol-sample-gallery-autoplay", (ev) => {
    try {
      const raw = ev && ev.detail && ev.detail.events;
      if (!Array.isArray(raw) || !raw.length) return;
      ensureCtx();
      enterAutoPlayFromMidiEvents(raw, "autoplay_sample_gallery_smiles");
    } catch (_e) {
      /* ignore */
    }
  });
} catch (_e) {
  /* ignore */
}

function setWhiteStart(v) {
  whiteStart = Math.max(0, Math.min(getMaxStart(), v));
  renderKeyboard();
  updateMinimapViewport();
}

function setWhiteVisibleCount(next, opts = {}) {
  const prevVis = whiteVisible;
  const w = Math.max(WHITE_VISIBLE_MIN, Math.min(WHITE_VISIBLE_MAX, Math.round(next)));
  const anchorIdx =
    opts.anchorWhiteIndex != null
      ? Math.min(WHITE_TOTAL - 1, Math.max(0, opts.anchorWhiteIndex))
      : Math.min(WHITE_TOTAL - 1, Math.max(0, Math.floor(whiteStart + prevVis / 2)));
  whiteVisible = w;
  document.documentElement.style.setProperty("--white-count", String(whiteVisible));
  let ns = Math.round(anchorIdx - whiteVisible / 2);
  ns = Math.max(0, Math.min(getMaxStart(), ns));
  whiteStart = ns;
  renderKeyboard();
  updateMinimapViewport();
  if (opts.fromUser) {
    const vp = document.getElementById("minimap-viewport");
    vp?.classList.add("minimap-viewport--instant");
    requestAnimationFrame(() => vp?.classList.remove("minimap-viewport--instant"));
  }
}

function renderMinimapStrip() {
  minimapEl.innerHTML = "";
  const row = document.createElement("div");
  row.className = "minimap-white-row";
  for (const m of WHITE_MIDIS) {
    const d = document.createElement("div");
    d.className = "minimap-key minimap-key--white";
    d.dataset.midi = String(m);
    row.appendChild(d);
  }
  minimapEl.appendChild(row);
  const layer = document.createElement("div");
  layer.className = "minimap-black-layer";
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (isWhite(m)) continue;
    const spec = MM_BLACK_SPECS.get(m);
    if (!spec) continue;
    const d = document.createElement("div");
    d.className = "minimap-key minimap-key--black";
    d.dataset.midi = String(m);
    d.style.left = `${spec.left}%`;
    d.style.width = `${spec.width}%`;
    layer.appendChild(d);
  }
  minimapEl.appendChild(layer);
}

function updateMinimapViewport() {
  const { leftPct, widthPct } = minimapViewportPercents(whiteStart);

  minimapViewport.style.left = `${leftPct}%`;
  minimapViewport.style.width = `${widthPct}%`;

  const sl = document.getElementById("minimap-shade-l");
  const sr = document.getElementById("minimap-shade-r");
  if (sl) sl.style.width = `${leftPct}%`;
  if (sr) {
    const rightLeft = leftPct + widthPct;
    sr.style.left = `${rightLeft}%`;
    sr.style.width = `${Math.max(0, 100 - rightLeft)}%`;
  }
}

let manualDragPointerId = null;
let manualDragMidi = null;

function canManualPlayNow() {
  if (isAutoMode) return false;
  if (isPianoGloballyLocked()) return false;
  if (minimapMoleculePanelLocksKeys()) return false;
  return true;
}

function manualPressMidi(midi, keyEl, point) {
  recordUserNoteOn(midi);
  postRealtimeMidiOutbound("note_on", midi, Math.round(0.55 * 127));
  keyEl?.classList.add("active");
  spawnKeyBubble(keyEl, midi, 0.55 * 127);
  if (typeof MusicMolFX3D !== 'undefined' && MusicMolFX3D.ready) {
    MusicMolFX3D.spawn(midiToSfKey(midi), { keyIndex: midi % 52, totalKeys: 52 });
  }
  playNote(midi, 0.55, { source: "manual_key" });
  manualDragMidi = midi;
}

function manualReleaseMidi(midi, keyEl) {
  const pending = recordOnsetStacks.get(midi);
  if (!pending || !pending.length) return;
  const startMs = pending[pending.length - 1] - (perfOriginMs || 0);
  recordUserNoteOff(midi);
  postRealtimeMidiOutbound("note_off", midi, 0);
  keyEl?.classList.remove("active");
  stopNote(midi);
  if (manualDragMidi === midi) manualDragMidi = null;
}

function releaseCurrentDragMidi() {
  if (manualDragMidi == null) return;
  const el = keyboardEl?.querySelector(`[data-midi="${manualDragMidi}"]`);
  manualReleaseMidi(manualDragMidi, el);
}

function endManualDrag(pointerId) {
  if (manualDragPointerId == null) return;
  if (pointerId != null && pointerId !== manualDragPointerId) return;
  releaseCurrentDragMidi();
  manualDragPointerId = null;
}

window.addEventListener("pointerup", (e) => {
  endManualDrag(e.pointerId);
});
window.addEventListener("pointercancel", (e) => {
  endManualDrag(e.pointerId);
});

function renderKeyboard() {
  keyboardEl.innerHTML = "";
  const slice = WHITE_MIDIS.slice(whiteStart, whiteStart + whiteVisible);

  slice.forEach((midi) => {
    const w = document.createElement("button");
    w.type = "button";
    w.className = "white-key";
    w.dataset.midi = String(midi);
    w.setAttribute("aria-label", midiToLabel(midi));

    const lab = document.createElement("span");
    lab.className = `key-label ${octaveClass(midi)}`;
    lab.textContent = midiToLabel(midi);
    w.appendChild(lab);

    const down = (e) => {
      e.preventDefault();
      if (!canManualPlayNow()) {
        if (isPianoGloballyLocked()) showModeLockToast();
        return;
      }
      if (manualDragPointerId != null && manualDragPointerId !== e.pointerId) return;
      manualDragPointerId = e.pointerId;
      if (manualDragMidi !== midi) releaseCurrentDragMidi();
      manualPressMidi(midi, w, { x: e.clientX, y: e.clientY });
    };

    const enter = (e) => {
      if (manualDragPointerId == null || e.pointerId !== manualDragPointerId) return;
      if (!canManualPlayNow()) return;
      if (manualDragMidi === midi) return;
      releaseCurrentDragMidi();
      manualPressMidi(midi, w, { x: e.clientX, y: e.clientY });
    };

    const up = (e) => {
      if (manualDragPointerId == null || e.pointerId !== manualDragPointerId) return;
      endManualDrag(e.pointerId);
    };

    w.addEventListener("pointerdown", down);
    w.addEventListener("pointerenter", enter);
    w.addEventListener("pointerup", up);
    w.addEventListener("pointercancel", up);

    keyboardEl.appendChild(w);
  });

  const whiteW = APP_WIDTH / whiteVisible;
  const blackW = whiteW * 0.58;
  const rawPlacements = gatherBlackPlacements(whiteStart);
  const laidOut = layoutBlackKeys(rawPlacements, blackW);

  laidOut.forEach(({ midi: blackMidi, left }, order) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "black-key";
    b.dataset.midi = String(blackMidi);
    b.setAttribute("aria-label", midiToLabel(blackMidi));
    b.style.left = `${left}px`;
    b.style.zIndex = String(3 + order);

    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!canManualPlayNow()) {
        if (isPianoGloballyLocked()) showModeLockToast();
        return;
      }
      if (manualDragPointerId != null && manualDragPointerId !== e.pointerId) return;
      manualDragPointerId = e.pointerId;
      if (manualDragMidi !== blackMidi) releaseCurrentDragMidi();
      manualPressMidi(blackMidi, b, { x: e.clientX, y: e.clientY });
    };

    const enter = (e) => {
      if (manualDragPointerId == null || e.pointerId !== manualDragPointerId) return;
      if (!canManualPlayNow()) return;
      if (manualDragMidi === blackMidi) return;
      releaseCurrentDragMidi();
      manualPressMidi(blackMidi, b, { x: e.clientX, y: e.clientY });
    };

    const up = (e) => {
      if (manualDragPointerId == null || e.pointerId !== manualDragPointerId) return;
      endManualDrag(e.pointerId);
    };

    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerenter", enter);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);

    keyboardEl.appendChild(b);
  });
}

/* ---------- Nav：minimap 平移 / 缩放 ---------- */
let minimapPanDidMove = false;
let minimapPanPtr = null;
let minimapPanStartX = 0;
let minimapPanStartWs = 0;
let minimapResizePtr = null;
let minimapResizeStartX = 0;
let minimapResizeStartVis = WHITE_VISIBLE_DEFAULT;
let minimapResizeAnchorIdx = 0;

minimapViewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#minimap-viewport-resize")) return;
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  minimapPanDidMove = false;
  minimapPanPtr = e.pointerId;
  minimapPanStartX = e.clientX;
  minimapPanStartWs = whiteStart;
  minimapViewport.classList.add("is-panning", "minimap-viewport--instant");
  try {
    minimapViewport.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
});

minimapViewport.addEventListener("pointermove", (e) => {
  if (minimapPanPtr !== e.pointerId) return;
  const rect = minimapWrap.getBoundingClientRect();
  if (rect.width < 8) return;
  const dx = e.clientX - minimapPanStartX;
  if (Math.abs(dx) > 3) minimapPanDidMove = true;
  const keyW = rect.width / WHITE_TOTAL;
  const deltaKeys = Math.round(dx / keyW);
  setWhiteStart(minimapPanStartWs - deltaKeys);
});

function minimapPanEnd(e) {
  if (minimapPanPtr !== e.pointerId) return;
  minimapPanPtr = null;
  minimapViewport.classList.remove("is-panning", "minimap-viewport--instant");
  try {
    minimapViewport.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

minimapViewport.addEventListener("pointerup", minimapPanEnd);
minimapViewport.addEventListener("pointercancel", minimapPanEnd);

const minimapResizeBtn = document.getElementById("minimap-viewport-resize");
minimapResizeBtn?.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  minimapResizePtr = e.pointerId;
  minimapResizeStartX = e.clientX;
  minimapResizeStartVis = whiteVisible;
  minimapResizeAnchorIdx = Math.min(WHITE_TOTAL - 1, Math.max(0, Math.floor(whiteStart + whiteVisible / 2)));
  minimapViewport.classList.add("minimap-viewport--instant");
  try {
    minimapResizeBtn.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
});

minimapResizeBtn?.addEventListener("pointermove", (e) => {
  if (minimapResizePtr !== e.pointerId) return;
  const rect = minimapWrap.getBoundingClientRect();
  if (rect.width < 8) return;
  const keyW = rect.width / WHITE_TOTAL;
  const dVis = Math.round((e.clientX - minimapResizeStartX) / keyW);
  setWhiteVisibleCount(minimapResizeStartVis + dVis, { fromUser: true, anchorWhiteIndex: minimapResizeAnchorIdx });
});

function minimapResizeEnd(e) {
  if (minimapResizePtr !== e.pointerId) return;
  minimapResizePtr = null;
  minimapViewport.classList.remove("minimap-viewport--instant");
  try {
    minimapResizeBtn?.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

minimapResizeBtn?.addEventListener("pointerup", minimapResizeEnd);
minimapResizeBtn?.addEventListener("pointercancel", minimapResizeEnd);

minimapWrap.addEventListener("click", (e) => {
  if (minimapPanDidMove) {
    minimapPanDidMove = false;
    return;
  }
  if (e.target.closest("#minimap-viewport") && !e.target.closest("#minimap-viewport-resize")) return;
  if (e.target.closest("#minimap-external-prompt")) return;
  if (e.target.closest("#minimap-molecule-panel")) return;
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  const rect = minimapWrap.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const targetPct = x * 100;
  let bestWs = 0;
  let bestDiff = Infinity;
  for (let ws = 0; ws <= getMaxStart(); ws++) {
    const { leftPct: vLeft } = minimapViewportPercents(ws);
    const diff = Math.abs(vLeft - targetPct);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestWs = ws;
    }
  }
  setWhiteStart(bestWs);
});

/* ---------- 点歌弹层（示例曲库）与接口 MIDI 提示 ---------- */

function closeSongOverlay() {
  const ov = document.getElementById("song-overlay");
  if (ov) {
    ov.hidden = true;
    ov.setAttribute("aria-hidden", "true");
  }
}

function buildSongMenuList() {
  const ul = document.getElementById("song-menu-list");
  if (!ul) return;
  ul.innerHTML = "";
  const data = window.SONGS_DATA || {};
  const keys = Object.keys(data);
  keys.forEach((key) => {
    const li = document.createElement("li");
    li.setAttribute("role", "button");
    li.tabIndex = 0;
    li.dataset.songKey = key;
    li.textContent = key.replace(/_/g, " · ");
    li.addEventListener("click", () => {
      ul.querySelectorAll("li").forEach((x) => x.classList.remove("is-selected"));
      li.classList.add("is-selected");
      selectedSongKey = key;
      const play = document.getElementById("song-play");
      if (play) play.disabled = false;
    });
    ul.appendChild(li);
  });
}

function openSongOverlay() {
  const ov = document.getElementById("song-overlay");
  if (!ov) return;
  selectedSongKey = null;
  const play = document.getElementById("song-play");
  if (play) play.disabled = true;
  buildSongMenuList();
  ov.hidden = false;
  ov.setAttribute("aria-hidden", "false");
}

/**
 * 轮询到待播 MIDI 后直接 dismiss 并自动演奏（不弹出确认条）。
 * 「分子生成音乐」模式下键盘仍对用户锁定，但服务端推送的 pending 必须在此播放，故不在此函数内做 isPianoGloballyLocked 拦截。
 * @param {unknown[]} events
 * @param {"molecule"|"external"} source
 */
let _currentMoleculeSessionId = null;

async function playReceivedMidiWithoutPrompt(events, source, sessionId) {
  if (!events || !events.length) return;
  if (source === "molecule") {
    /* 与后端入队可能不同步：先对齐「分子→音乐」模式并清横幅，避免仍按音乐→分子锁 UI / 轮询 */
    applyPianoInteractionModeFromServer("molecule_to_music");
    resetMinimapMoleculePanel();
    _pendingDemoSongKey = null;
    _pendingDemoSongSeq = null;
    _pendingDemoSongInferred = false;
    clearUserRecording();
    updateSongPickButtonLock();
    moleculeToast.hidden = true;
    resetMoleculeToastPanel();
  }
  ensureCtx();
  const dismissPath =
    source === "external" ? "/api/midi_exchange/ui_dismiss" : "/api/molecule_music_ui_dismiss";
  if (!isPainojsUnifiedSingleSameDocument()) {
    try {
      await fetch(`${API_BASE}${dismissPath}`, { method: "POST" });
    } catch {
      /* ignore */
    }
  }
  pendingPromptSource = null;
  const wrap = document.getElementById("minimap-external-prompt");
  if (wrap) {
    wrap.hidden = true;
    delete wrap.dataset.eventsJson;
  }
  syncMinimapWrapPromptOpen();
  const apSrc =
    source === "external" ? "autoplay_pending_external_midi" : "autoplay_pending_molecule";
  // 保存 session_id 用于演奏结束时的 phase 上报
  _currentMoleculeSessionId = sessionId || null;
  // 上报「演奏开始」
  if (_currentMoleculeSessionId) {
    postManualMoleculeMusicPhase(_currentMoleculeSessionId, "playing");
  }
  enterAutoPlayFromMidiEvents(events, apSrc);
}

document.getElementById("btn-song").addEventListener("click", () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  if (
    pianoInteractionMode === "music_to_molecule" &&
    (userPerformance.length > 0 ||
      (_pendingDemoSongKey && _pendingDemoSongSeq && !_pendingDemoSongInferred))
  ) {
    return;
  }
  openSongOverlay();
});

document.getElementById("song-close")?.addEventListener("click", closeSongOverlay);
document.getElementById("song-exit")?.addEventListener("click", closeSongOverlay);

document.getElementById("song-play")?.addEventListener("click", async () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  if (!selectedSongKey || !window.SONGS_DATA) return;
  const seq = window.SONGS_DATA[selectedSongKey];
  if (!seq || !seq.length) return;
  ensureCtx();
  closeSongOverlay();

  // 暂存歌曲数据，等演奏结束后由用户点击「生成分子」时执行 AI 推理
  _pendingDemoSongKey = selectedSongKey;
  _pendingDemoSongSeq = seq;
  _pendingDemoSongInferred = false;
  updateSongPickButtonLock();

  // 直接开始演奏，不执行 AI 推理
  const evs = seq.map((e) => ({
    note: e.midi,
    time: e.startMs,
    duration: Math.max(40, e.endMs - e.startMs),
    velocity: 92,
  }));
  enterAutoPlayFromMidiEvents(evs, "autoplay_demo_song");

  // 播放开始时向 8082 发送 MIDI 事件（仅 events，不含 smiles）
  postGlassSessionForDemoSong(selectedSongKey, seq, null, null, "midi");
});

document.getElementById("ext-midi-yes")?.addEventListener("click", async () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  const wrap = document.getElementById("minimap-external-prompt");
  let events = [];
  try {
    events = JSON.parse(wrap?.dataset.eventsJson || "[]");
  } catch {
    events = [];
  }
  if (wrap) wrap.hidden = true;
  syncMinimapWrapPromptOpen();
  pendingMolMusicUiKey = null;
  const srcSaved = pendingPromptSource;
  if (!isPainojsUnifiedSingleSameDocument()) {
    try {
      await fetch(
        `${API_BASE}${srcSaved === "external" ? "/api/midi_exchange/ui_dismiss" : "/api/molecule_music_ui_dismiss"}`,
        { method: "POST" }
      );
    } catch {
      /* ignore */
    }
  }
  pendingPromptSource = null;
  if (events.length) {
    const apSrc =
      srcSaved === "external" ? "autoplay_pending_external_midi" : "autoplay_pending_molecule";
    enterAutoPlayFromMidiEvents(events, apSrc);
  }
});

document.getElementById("ext-midi-no")?.addEventListener("click", async () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  const wrap = document.getElementById("minimap-external-prompt");
  if (wrap) wrap.hidden = true;
  syncMinimapWrapPromptOpen();
  pendingMolMusicUiKey = null;
  if (!isPainojsUnifiedSingleSameDocument()) {
    try {
      await fetch(
        `${API_BASE}${pendingPromptSource === "external" ? "/api/midi_exchange/ui_dismiss" : "/api/molecule_music_ui_dismiss"}`,
        { method: "POST" }
      );
    } catch {
      /* ignore */
    }
  }
  pendingPromptSource = null;
});

if (!isPainojsUnifiedSingleSameDocument()) {
  setInterval(async () => {
    /* 分子→音乐 pending 必须最先拉取：不得被 isAutoMode（点歌/预览等）或外部 MIDI 条挡住，否则大屏发 SMILES 后钢琴永远不播 */
    try {
      const r = await fetch(`${API_BASE}/api/molecule_music_ui_pending`);
      const d = await r.json();
      if (d.pending && d.midi_events && d.midi_events.length) {
        const sig = `seq:${d.seq}|${d.canonical_smiles || d.smiles || ""}|${d.midi_events.length}`;
        if (pendingMolMusicUiKey !== sig) {
          pendingMolMusicUiKey = sig;
          void playReceivedMidiWithoutPrompt(d.midi_events, "molecule", d.session_id).catch(() => {
            pendingMolMusicUiKey = null;
          });
        }
        return;
      }
    } catch {
      /* ignore */
    }
    /* 仍在「音乐→分子」且自动演奏中：不轮询外部裸 MIDI（分子队列已在上方处理） */
    if (isAutoMode && pianoInteractionMode === "music_to_molecule") return;
    const pr = document.getElementById("minimap-external-prompt");
    if (pr && !pr.hidden) return;
    const molP = document.getElementById("minimap-molecule-panel");
    if (molP && !molP.hidden) return;
    /*
     * 分子→音乐（键盘锁定）时仍须轮询 midi_exchange/ui_pending：
     * 样例「播放分子音乐」在 POST molecule_submit 后常伴 POST midi_exchange 或映射端入队，
     * 若此处因 isPianoGloballyLocked 直接 return，底栏钢琴永远不播 pending。
     * 非本页来源的裸 MIDI 抢播风险由 pending 签名去重与上游 label 约束缓解。
     */
    try {
      const r = await fetch(`${API_BASE}/api/midi_exchange/ui_pending`);
      const d = await r.json();
      if (d.pending && d.events && d.events.length) {
        const sig = `ext:${d.label || ""}|${d.events.length}|${d.bpm || 100}`;
        if (pendingMolMusicUiKey !== sig) {
          pendingMolMusicUiKey = sig;
          void playReceivedMidiWithoutPrompt(d.events, "external").catch(() => {
            pendingMolMusicUiKey = null;
          });
        }
      }
    } catch {
      /* ignore */
    }
  }, 2000);
}

document.getElementById("btn-molecule").addEventListener("click", (e) => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  ensureCtx();
  if (e.altKey) {
    openScoreOverlay();
    const sc = document.getElementById("score-sheet-scroll");
    if (sc) sc.scrollLeft = 0;
    return;
  }
  // 如果有暂存的点歌数据且尚未推理，优先走点歌的 AI 推理
  if (_pendingDemoSongKey && _pendingDemoSongSeq && !_pendingDemoSongInferred) {
    void runMoleculeInferenceForDemoSong();
    return;
  }
  void runMoleculeInferenceFromPerformance();
});

document.getElementById("score-preview").addEventListener("click", () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  previewRecording();
});

document.getElementById("score-send").addEventListener("click", () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  confirmSendRecording();
});

document.getElementById("btn-reset").addEventListener("click", () => {
  if (isPianoGloballyLocked()) {
    showModeLockToast();
    return;
  }
  cancelAutoSong();
  cancelPreviewPlayback();
  clearUserRecording();
  closeScoreOverlay();
  closeSongOverlay();
  setAutoMode(false);
  pendingMolMusicUiKey = null;
  pendingPromptSource = null;
  // 重置点歌暂存状态
  _pendingDemoSongKey = null;
  _pendingDemoSongSeq = null;
  _pendingDemoSongInferred = false;
  updateSongPickButtonLock();
  const pr = document.getElementById("minimap-external-prompt");
  if (pr) pr.hidden = true;
  resetMinimapMoleculePanel();
  if (!isPainojsUnifiedSingleSameDocument()) {
    fetch(`${API_BASE}/api/molecule_music_ui_dismiss`, { method: "POST" }).catch(() => {});
  }
  whiteVisible = WHITE_VISIBLE_DEFAULT;
  document.documentElement.style.setProperty("--white-count", String(whiteVisible));
  whiteStart = Math.max(0, Math.min(getMaxStart(), Math.floor(getMaxStart() / 2)));
  renderKeyboard();
  updateMinimapViewport();
  resetMoleculeToastPanel();
  moleculeToast.hidden = true;
  for (const m of [...activeSources.keys()]) {
    stopNote(m);
  }
  document.querySelectorAll(".white-key.active, .black-key.active").forEach((el) => {
    el.classList.remove("active");
  });
});

document.getElementById("score-close")?.addEventListener("click", () => {
  closeScoreOverlay();
});

/* ---------- 禁用缩放和右键菜单 ---------- */
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "-" || e.key === "0" || e.key === "=")) {
    e.preventDefault();
  }
  if (e.key === "F12") e.preventDefault();
}, { passive: false });

/* ---------- 触摸屏全局滑动演奏支持 ---------- */
let touchDragPointerId = null;
let touchDragMidi = null;

function getKeyAtPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const key = el.closest(".white-key, .black-key");
  if (!key) return null;
  const midi = Number(key.dataset.midi);
  return Number.isFinite(midi) ? { midi, el: key } : null;
}

function touchPressMidi(midi, keyEl, point) {
  if (touchDragMidi === midi) return;
  if (touchDragMidi != null) touchReleaseCurrent();
  touchDragMidi = midi;
  manualPressMidi(midi, keyEl, point);
}

function touchReleaseCurrent() {
  if (touchDragMidi == null) return;
  const el = keyboardEl?.querySelector(`[data-midi="${touchDragMidi}"]`);
  manualReleaseMidi(touchDragMidi, el);
  touchDragMidi = null;
}

function touchEndDrag() {
  touchReleaseCurrent();
  touchDragPointerId = null;
}

if (keyboardStage) {
  keyboardStage.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const hit = getKeyAtPoint(e.clientX, e.clientY);
    if (!hit) return;
    if (!canManualPlayNow()) {
      if (isPianoGloballyLocked()) showModeLockToast();
      return;
    }
    touchDragPointerId = e.pointerId;
    keyboardStage.setPointerCapture(e.pointerId);
    touchPressMidi(hit.midi, hit.el, { x: e.clientX, y: e.clientY });
  });

  keyboardStage.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") return;
    if (touchDragPointerId == null || e.pointerId !== touchDragPointerId) return;
    const hit = getKeyAtPoint(e.clientX, e.clientY);
    if (!hit) {
      touchReleaseCurrent();
      return;
    }
    if (touchDragMidi !== hit.midi) {
      touchPressMidi(hit.midi, hit.el, { x: e.clientX, y: e.clientY });
    }
  });

  keyboardStage.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    if (touchDragPointerId == null || e.pointerId !== touchDragPointerId) return;
    keyboardStage.releasePointerCapture(e.pointerId);
    touchEndDrag();
  });

  keyboardStage.addEventListener("pointercancel", (e) => {
    if (e.pointerType !== "touch") return;
    if (touchDragPointerId == null || e.pointerId !== touchDragPointerId) return;
    touchEndDrag();
  });
}

/* ---------- Boot ---------- */
(function initMusicmolEmbedUnifiedFit() {
  try {
    const q = String(typeof location !== "undefined" ? location.search || "" : "");
    const path = String(typeof location !== "undefined" ? location.pathname || "" : "");
    const unifiedSingle =
      /\bunifiedSingle=1\b/i.test(q) ||
      /(^|\/)unified-single\.html$/i.test(path) ||
      (typeof document !== "undefined" &&
        document.documentElement &&
        document.documentElement.classList.contains("unified-single"));
    const embedUnified = /\bembed=unified\b/i.test(q);
    if (!embedUnified && !unifiedSingle) {
      return;
    }
    const dock =
      typeof document !== "undefined" ? document.getElementById("musicmol-piano-dock") : null;
    if (unifiedSingle) {
      if (dock) dock.classList.add("mm-embed-unified");
    } else {
      document.documentElement.classList.add("musicmol-embed-unified");
    }
    let lastPostedChromeH = -1;
    /** 合一单页：供 CSS 弹层（自定义分子等）扣减底栏高度，避免 100dvh 盖住钢琴 */
    const setUnifiedDockCssVar = (h) => {
      if (!unifiedSingle) return;
      try {
        const n = Number(h);
        if (Number.isFinite(n) && n > 40) {
          document.documentElement.style.setProperty("--unified-musicmol-dock-h", `${Math.ceil(n)}px`);
        }
      } catch {
        /* ignore */
      }
    };
    const tick = () => {
      let bw;
      let bhViewport;
      const dockCollapsed =
        unifiedSingle &&
        typeof document !== "undefined" &&
        document.documentElement &&
        document.documentElement.classList.contains("unified-piano-dock-collapsed");
      /*
       * 收起时不再提前 return：缩放与 chromeH 与展开态同一套算法，保证轮询/自动演奏/WebGL 尺寸不断档；
       * 仅最后在 dock 上写入 rail 高度，#app 由 CSS 离屏（见 unified-single.css）。
       */
      if (unifiedSingle && dock) {
        const r = dock.getBoundingClientRect();
        bw = Math.max(8, r.width);
        /*
         * 底栏高度由下方 chromeH 写入；此处用于缩放的「可用高」不能与当前 r.height 强耦合（首帧易偏小）。
         * 按整页视口 + 展陈区预留，保证钢琴缩放在窄矮屏仍一次算准，且展陈至少保留一截给 Three / 标题。
         */
        let vh = 0;
        try {
          vh = Math.floor(window.visualViewport?.height || window.innerHeight || 0);
        } catch {
          vh = Math.floor(window.innerHeight || 0);
        }
        vh = Math.max(320, vh);
        let usable = vh;
        try {
          usable -= Math.max(
            0,
            Math.floor(
              Number.parseFloat(
                String(getComputedStyle(document.documentElement).paddingTop || "0").replace("px", "") || "0"
              ) || 0
            )
          );
        } catch {
          /* */
        }
        /** 展陈最小预留（视口比例）：略减以为底栏钢琴让出约 +20% 纵向空间 */
        const expoMinFrac = 0.24;
        const dockMaxFrac = 0.384; /* 0.32 * 1.2 */
        const dockCapFrac = 0.396; /* 0.33 * 1.2 */
        let minExpo = Math.min(168, Math.floor(usable * expoMinFrac));
        minExpo = Math.max(104, minExpo);
        let maxDockPx = Math.max(118, Math.min(Math.floor(usable * dockMaxFrac), usable - minExpo));
        try {
          const root = document.getElementById("unified-single-root");
          if (root) {
            const rh = Math.floor(root.getBoundingClientRect().height || 0);
            if (rh > 100) {
              const minExpoPx = Math.max(104, Math.min(180, Math.floor(rh * expoMinFrac)));
              maxDockPx = Math.min(maxDockPx, Math.max(118, rh - minExpoPx));
            }
          }
        } catch {
          /* */
        }
        maxDockPx = Math.max(118, Math.min(maxDockPx, Math.floor(usable * dockCapFrac)));
        bhViewport = Math.max(112, maxDockPx);
      } else {
        bw = document.body?.clientWidth || 1;
        const ih = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 0;
        const dch = document.documentElement?.clientHeight || 0;
        const bh0 = document.body?.clientHeight || 0;
        /*
         * 缩放用「可用视口高」：Electron / 部分嵌套环境下 innerHeight 可能大于 iframe 的 documentElement.clientHeight，
         * 若取 max 会把 s 算成 1，进而 chromeH≈全量 #app 高度，父页底栏被撑到 ~620px，钢琴 iframe 顶部出现大块留白。
         * 二者皆有时取 min；否则退化为 max(ih,dch,bh0)。
         */
        const bhV =
          ih > 8 && dch > 8
            ? Math.max(Math.min(ih, dch), 8)
            : Math.max(ih, dch, bh0, 8);
        bhViewport = bhV;
      }
      if (bw < 8 || bhViewport < 8) return;
      const appEl = document.getElementById("app");
      const ah = appEl && appEl.offsetHeight > 0 ? appEl.offsetHeight : 420;
      const sW = bw / 1920;
      const sH = bhViewport / ah;
      /* 默认等比；若高度先卡死（s < sW），用略小的有效设计高做分母，让缩放略大、多占宽度，顶区少量裁切由 overflow:hidden 吃掉，减少左右大留白 */
      let s = Math.min(1, sW, sH);
      if (s < sW - 1e-4) {
        const ahEff = Math.max(300, ah - 52);
        const sBoost = Math.min(1, sW, bhViewport / ahEff);
        s = Math.min(sW, Math.max(s, sBoost));
      }
      const sc = Number.isFinite(s) && s > 0 ? s : 1;
      document.documentElement.style.setProperty("--musicmol-embed-scale", String(sc));
      const scaledH = ah * sc;
      const chromeCap = 640;
      /* 合一单页底栏可略矮于 iframe 壳，以便极限视高下展陈仍保留可点区域 */
      const chromeLo = unifiedSingle ? 118 : 200;
      const chromePad = unifiedSingle ? 2 : 6;
      let chromeH = Math.max(chromeLo, Math.min(chromeCap, Math.ceil(scaledH) + chromePad));
      try {
        if (appEl && typeof appEl.getBoundingClientRect === "function") {
          const br = appEl.getBoundingClientRect();
          const vhRaw = br.height;
          if (Number.isFinite(vhRaw) && vhRaw > 6) {
            if (unifiedSingle) {
              chromeH = Math.max(chromeLo, Math.min(chromeCap, Math.ceil(vhRaw) + chromePad));
            } else {
              const vh = Math.min(vhRaw, scaledH + 4);
              chromeH = Math.max(chromeLo, Math.min(chromeCap, Math.ceil(vh) + 6));
            }
          }
        }
      } catch {
        /* ignore */
      }
      /* 仅当 iframe 已明显高于可用下限时才用 clientHeight 收敛，避免矮 iframe 把 chromeH 锁死 */
      if (!unifiedSingle) {
        try {
          const cap = document.documentElement?.clientHeight;
          if (Number.isFinite(cap) && cap >= 220) {
            chromeH = Math.max(chromeLo, Math.min(chromeH, Math.floor(cap)));
          }
        } catch {
          /* ignore */
        }
      }
      if (unifiedSingle && typeof window !== "undefined" && window.innerHeight > 120) {
        const vcapFrac = 0.372; /* 0.31 * 1.2，与底栏增高一致 */
        let vcap = Math.floor(window.innerHeight * vcapFrac);
        try {
          vcap = Math.floor((window.visualViewport?.height || window.innerHeight) * vcapFrac);
        } catch {
          /* */
        }
        chromeH = Math.max(chromeLo, Math.min(chromeH, vcap));
        try {
          const root = document.getElementById("unified-single-root");
          if (root) {
            const rh = Math.floor(root.getBoundingClientRect().height || 0);
            if (rh > 120) {
              const minExpoPx = Math.max(112, Math.min(200, Math.floor(rh * 0.24)));
              chromeH = Math.min(chromeH, Math.max(chromeLo, rh - minExpoPx));
            }
          }
        } catch {
          /* */
        }
      }
      let chromeReportForGlobals = chromeH;
      if (unifiedSingle && dock) {
        try {
          if (dockCollapsed) {
            let rail = 52;
            try {
              const vvh = Math.floor(window.visualViewport?.height || window.innerHeight || 640);
              rail = Math.max(44, Math.min(60, Math.round(vvh * 0.082)));
            } catch {
              /* */
            }
            dock.style.setProperty("min-height", `${rail}px`, "important");
            dock.style.setProperty("height", `${rail}px`, "important");
            dock.style.setProperty("max-height", `${rail}px`, "important");
            dock.style.setProperty("flex", "0 0 auto", "important");
            setUnifiedDockCssVar(rail);
            chromeReportForGlobals = rail;
          } else {
            dock.style.setProperty("min-height", `${chromeH}px`, "important");
            dock.style.setProperty("height", `${chromeH}px`, "important");
            dock.style.setProperty("max-height", `${chromeH}px`, "important");
            dock.style.setProperty("flex", "0 0 auto", "important");
            setUnifiedDockCssVar(chromeH);
          }
        } catch {
          /* ignore */
        }
      } else {
        /* 与上报父页的 chrome 同高：body 不再 min-height:100% 撑满 iframe，消除 #app 上方整条留白 */
        try {
          document.documentElement.style.setProperty("height", `${chromeH}px`, "important");
          document.body.style.setProperty("height", `${chromeH}px`, "important");
          document.body.style.setProperty("min-height", "0", "important");
        } catch {
          /* ignore */
        }
      }
      try {
        if (!unifiedSingle && window.parent && window.parent !== window) {
          if (Math.abs(chromeH - lastPostedChromeH) > 1) {
            lastPostedChromeH = chromeH;
            window.parent.postMessage(
              { type: "musicmolUnifiedPianoChrome", h: chromeH },
              typeof location !== "undefined" && location.origin ? location.origin : "*"
            );
          }
        }
      } catch {
        /* ignore */
      }
      /* 供 unified.html 同源读取；合一收起时上报底栏占位 rail，与 --unified-musicmol-dock-h 一致 */
      try {
        window.__MUSICMOL_UNIFIED_CHROME_H__ = unifiedSingle ? chromeReportForGlobals : chromeH;
      } catch {
        /* ignore */
      }
    };
    try {
      window.addEventListener("musicmol-unified-dock-layout", tick);
    } catch {
      /* */
    }
    tick();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(tick);
      if (unifiedSingle && dock) {
        const rootEl = document.getElementById("unified-single-root");
        const expoEl = document.querySelector(".unified-single-exhibition");
        if (rootEl) ro.observe(rootEl);
        if (expoEl) ro.observe(expoEl);
        ro.observe(dock);
        const appEl0 = document.getElementById("app");
        if (appEl0) ro.observe(appEl0);
      } else if (document.body) {
        ro.observe(document.body);
        const appEl0 = document.getElementById("app");
        if (appEl0) ro.observe(appEl0);
      }
    } else {
      window.addEventListener("resize", tick);
    }
    requestAnimationFrame(() => {
      tick();
      requestAnimationFrame(tick);
    });
    setTimeout(tick, 80);
    setTimeout(tick, 400);
    if (unifiedSingle && typeof window !== "undefined" && window.visualViewport) {
      try {
        window.visualViewport.addEventListener("resize", tick, { passive: true });
        window.visualViewport.addEventListener("scroll", tick, { passive: true });
      } catch {
        /* */
      }
    }
  } catch {
    /* ignore */
  }
})();
document.documentElement.style.setProperty("--white-count", String(whiteVisible));
whiteStart = Math.max(0, Math.min(getMaxStart(), Math.floor(getMaxStart() / 2)));
verifyPianoRange();
renderMinimapStrip();
renderKeyboard();
updateMinimapViewport();

updateSongPickButtonLock();
void syncPianoInteractionMode();
setTimeout(() => {
  void syncPianoInteractionMode();
}, 220);
setTimeout(() => {
  void syncPianoInteractionMode();
}, 900);
if (!isPainojsUnifiedSingleSameDocument()) {
  setInterval(syncPianoInteractionMode, 1500);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncPianoInteractionMode();
  });
} else {
  window.addEventListener("musicmol:piano-interaction-mode", (e) => {
    const ev = /** @type {CustomEvent<{ mode?: string }>} */ (e);
    const m = ev && ev.detail && String(ev.detail.mode || "");
    if (m === "molecule_to_music" || m === "music_to_molecule") {
      applyPianoInteractionModeFromServer(m);
    }
  });
  window.addEventListener("hashchange", () => {
    void syncPianoInteractionMode();
  });
}

document.body.addEventListener("click", () => ensureCtx(), { once: true });
