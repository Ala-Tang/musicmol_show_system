/**
 * 88 键钢琴白键共 52 个；视窗固定显示 WHITE_VISIBLE 个白键（与 1920px 对应）。
 * 物理：941mm / 52 ≈ 18.1mm（不足 23mm）；941/40 ≈ 23.525mm（满足 ≥23mm）。
 */
const MIDI_MIN = 21;
const MIDI_MAX = 108;
const WHITE_VISIBLE = 40;
const APP_WIDTH = 1920;

function isPianoEmbedUnified() {
  try {
    return /\bembed=unified\b/i.test(String(window.location.search || ""));
  } catch {
    return false;
  }
}

function updatePianoEmbedUnifiedScale() {
  if (!isPianoEmbedUnified()) return;
  const root = document.querySelector(".piano-root");
  if (!root) return;
  const w = root.clientWidth;
  const h = root.clientHeight;
  if (w < 8 || h < 8) return;
  const s = Math.min(1, w / APP_WIDTH, h / 360);
  const scale = Number.isFinite(s) && s > 0 ? s : 1;
  document.documentElement.style.setProperty("--piano-fit-scale", String(scale));
}

function initPianoEmbedUnified() {
  if (!isPianoEmbedUnified()) return;
  document.documentElement.classList.add("piano-embed-unified");
  updatePianoEmbedUnifiedScale();
  const root = document.querySelector(".piano-root");
  if (typeof ResizeObserver !== "undefined" && root) {
    const ro = new ResizeObserver(() => updatePianoEmbedUnifiedScale());
    ro.observe(root);
  } else {
    window.addEventListener("resize", updatePianoEmbedUnifiedScale);
  }
  requestAnimationFrame(() => {
    updatePianoEmbedUnifiedScale();
    requestAnimationFrame(updatePianoEmbedUnifiedScale);
  });
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
const MAX_START = WHITE_TOTAL - WHITE_VISIBLE;

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
 * MusicMol Flask API 根地址（与 `MusicMol_0322/musicmol-piano.js`、`piano.js` 对齐）。
 * 映射端：页面在任意主机打开时，请求应指向「运行 MusicMol 的那台机器」的 :5020，而不是浏览器的 127.0.0.1。
 * 覆盖：window.MUSICMOL_API_BASE 或 URL 参数 musicmol_api=http://主机:5020
 */
function getMusicMolApiBase() {
  if (typeof window !== "undefined" && window.MUSICMOL_API_BASE) {
    return String(window.MUSICMOL_API_BASE).replace(/\/$/, "");
  }
  try {
    const q = new URLSearchParams(window.location.search || "").get("musicmol_api");
    if (q && /^https?:\/\//i.test(q)) return q.replace(/\/$/, "");
  } catch {
    /* ignore */
  }
  if (typeof location === "undefined" || !location.href) return "http://127.0.0.1:5020";
  if (location.protocol === "file:") return "http://127.0.0.1:5020";
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  const host = location.hostname || "127.0.0.1";
  const proto = location.protocol === "https:" ? "https:" : "http:";
  // 8766 = PAINOJS 映射端口（非 MusicMol）；8081 类同；二者仅托管前端，MusicMol API 仍为同主机 :5020
  if (port === "8081" || port === "8766") return `${proto}//${host}:5020`.replace(/\/$/, "");
  if (port === "5020") return (location.origin || "").replace(/\/$/, "");
  return `${proto}//${host}:5020`.replace(/\/$/, "");
}

const API_BASE = getMusicMolApiBase();

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

const NOTE_COLORS = [
  "#ff5252","#ff4081","#e040fb","#7c4dff","#536dfe",
  "#448aff","#40c4ff","#18ffff","#64ffda","#69f0ae",
  "#b2ff59","#eeff41","#ffff00","#ffd740","#ffab40",
  "#ff6e40","#ff5252","#ff4081","#e040fb","#7c4dff",
  "#536dfe","#448aff","#40c4ff","#18ffff","#64ffda",
  "#69f0ae","#b2ff59","#eeff41","#ffff00","#ffd740",
  "#ffab40","#ff6e40","#ff5252","#ff4081","#e040fb",
  "#7c4dff","#536dfe","#448aff","#40c4ff","#18ffff",
  "#64ffda","#69f0ae","#b2ff59","#eeff41","#ffff00",
  "#ffd740","#ffab40","#ff6e40","#ff5252","#ff4081",
  "#e040fb","#7c4dff","#536dfe","#448aff","#40c4ff",
  "#18ffff","#64ffda","#69f0ae","#b2ff59","#eeff41",
  "#ffff00","#ffd740","#ffab40","#ff6e40","#ff5252",
  "#ff4081","#e040fb","#7c4dff","#536dfe","#448aff",
  "#40c4ff","#18ffff","#64ffda","#69f0ae","#b2ff59",
  "#eeff41","#ffff00","#ffd740","#ffab40","#ff6e40",
  "#ff5252","#ff4081","#e040fb","#7c4dff","#536dfe",
  "#448aff","#40c4ff","#18ffff"
];

function noteColor(midi) {
  return NOTE_COLORS[(midi - MIDI_MIN) % NOTE_COLORS.length];
}

function buildStaffSvg(midi) {
  const color = noteColor(midi);
  const stemUp = midi < 67;
  const stemX = stemUp ? 14 : 26;
  const stemY1 = stemUp ? 10 : 36;
  const stemY2 = stemUp ? 34 : 58;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 68" aria-hidden="true">
    <ellipse cx="20" cy="34" rx="6" ry="4.5" fill="${color}" transform="rotate(-18 20 34)"/>
    <line x1="${stemX}" y1="${stemY1}" x2="${stemX}" y2="${stemY2}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function spawnFloatingStaffNote(clientX, clientY, midi) {
  const stage = document.getElementById("keyboard-stage");
  const layer = document.getElementById("fx-layer");
  if (!stage || !layer) return;
  const r = stage.getBoundingClientRect();
  const x = clientX - r.left;
  const y = clientY - r.top;
  const el = document.createElement("div");
  el.className = "floating-note";
  el.innerHTML = buildStaffSvg(midi);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  layer.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

/**
 * 收集当前视窗内应绘制的黑键（含左侧跨窗黑键），按 MIDI 去重。
 * centerX 为琴键区域水平坐标（0…1920），落在相邻白键缝隙处。
 */
function gatherBlackPlacements(whiteStart) {
  const slice = WHITE_MIDIS.slice(whiteStart, whiteStart + WHITE_VISIBLE);
  const whiteW = APP_WIDTH / WHITE_VISIBLE;
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
const activeOsc = new Map();

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

function playNote(midi, velocity = 0.55) {
  const ctx = ensureCtx();
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

  activeOsc.set(midi, { master, osc1, osc2, ctx });
}

function stopNote(midi) {
  const pack = activeOsc.get(midi);
  if (!pack) return;
  const { master, osc1, osc2, ctx } = pack;
  const now = ctx.currentTime;
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
  activeOsc.delete(midi);
  setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      /* ignore */
    }
  }, (release + 0.1) * 1000);
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
}

function clearUserRecording() {
  userPerformance.length = 0;
  perfOriginMs = null;
  recordOnsetStacks.clear();
  cancelPreviewPlayback();
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
      '<div class="score-empty">暂无弹奏记录。请先弹奏钢琴后，再点击「生成分子」。</div>';
    return;
  }
  const sorted = [...userPerformance].sort((a, b) => a.startMs - b.startMs);
  const pxPerMs = 0.2;
  const padL = 52;
  const padR = 40;
  const maxT = Math.max(...sorted.map((e) => e.endMs), 0);
  const W = Math.max(400, Math.ceil(padL + maxT * pxPerMs + padR));
  const H = 110;
  const staffYs = [28, 36, 44, 52, 60];
  const lines = staffYs
    .map(
      (y) =>
        `<line x1="${padL - 10}" x2="${W - padR + 10}" y1="${y}" y2="${y}" stroke="#0f0f12" stroke-width="1.25" stroke-linecap="round"/>`
    )
    .join("");
  const clef = `<text x="4" y="62" font-size="32" fill="#0f0f12" font-family="'Segoe UI Symbol',serif">𝄞</text>`;
  const parts = [lines, clef];
  for (const ev of sorted) {
    const cx = padL + ev.startMs * pxPerMs + 8;
    const cy = Math.max(14, Math.min(76, scoreNoteCy(ev.midi)));
    const sharp = [1, 3, 6, 8, 10].includes(ev.midi % 12);
    if (sharp) {
      parts.push(
        `<text x="${cx - 12}" y="${cy + 4}" font-size="13" fill="#0f0f12" text-anchor="middle" font-family="serif">♯</text>`
      );
    }
    const stemUp = ev.midi < 67;
    const sx = stemUp ? cx - 4 : cx + 6;
    const y1 = stemUp ? cy - 20 : cy + 2;
    const y2 = stemUp ? cy + 2 : cy + 22;
    parts.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="5" ry="3.5" fill="#111" transform="rotate(-16 ${cx} ${cy})"/>` +
        `<line x1="${sx}" y1="${y1}" x2="${sx}" y2="${y2}" stroke="#111" stroke-width="1.2" stroke-linecap="round"/>`
    );
  }
  container.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join("")}</svg>`;
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
      playNote(ev.midi);
    }, ev.startMs);
    setTimeout(() => {
      if (job !== previewPlaybackId) return;
      stopNote(ev.midi);
    }, ev.endMs);
  }
}

async function confirmSendRecording() {
  if (!userPerformance.length) {
    moleculeToast.textContent = "没有可发送的弹奏记录。";
    moleculeToast.hidden = false;
    setTimeout(() => {
      moleculeToast.hidden = true;
    }, 2400);
    return;
  }
  closeScoreOverlay();
  showAiProgress("AI 计算中，正在生成分子…");
  setApiStatus("musicToMolecule", "sending");
  try {
    const events = userPerformance.map((e) => ({
      note: e.midi,
      start: Math.round(e.startMs),
      duration: Math.round(e.endMs - e.startMs),
    }));
    const resp = await fetch(`${API_BASE}/api/music_to_molecule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events, bpm: 100, push_outbound_smiles: true }),
    });
    const data = await resp.json();
    setApiStatus("musicToMolecule", "online");
    hideAiProgress();
    if (data.ok && data.best_smiles) {
      showConfetti();
      moleculeToast.innerHTML = `<div>生成分子完成！<br><small style="opacity:0.8">SMILES: ${data.best_smiles}</small></div>`;
      moleculeToast.hidden = false;
      setTimeout(() => { moleculeToast.hidden = true; }, 6000);
    } else {
      moleculeToast.textContent = "生成失败: " + (data.error || "未知错误");
      moleculeToast.hidden = false;
      setTimeout(() => { moleculeToast.hidden = true; }, 4000);
    }
  } catch (err) {
    setApiStatus("musicToMolecule", "offline");
    hideAiProgress();
    moleculeToast.textContent = "网络错误，无法连接到 AI 服务。";
    moleculeToast.hidden = false;
    setTimeout(() => { moleculeToast.hidden = true; }, 4000);
  }
  clearUserRecording();
}

function showAiProgress(text) {
  let bar = document.getElementById("ai-progress");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "ai-progress";
    bar.className = "ai-progress";
    bar.innerHTML = `<div class="ai-progress-inner"><div class="ai-progress-bar"></div><div class="ai-progress-text"></div></div>`;
    document.getElementById("app").appendChild(bar);
  }
  bar.querySelector(".ai-progress-text").textContent = text;
  bar.hidden = false;
}

function hideAiProgress() {
  const bar = document.getElementById("ai-progress");
  if (bar) bar.hidden = true;
}

function showConfetti() {
  const layer = document.getElementById("fx-layer");
  if (!layer) return;
  const colors = ["#ff5252","#448aff","#69f0ae","#ffd740","#ff4081","#18ffff"];
  for (let i = 0; i < 60; i++) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = "50%";
    el.style.top = "40%";
    el.style.width = "6px";
    el.style.height = "6px";
    el.style.borderRadius = "50%";
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.pointerEvents = "none";
    el.style.zIndex = "30";
    const angle = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 160;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 60;
    el.style.transition = "transform 0.9s cubic-bezier(0.22,1,0.36,1), opacity 0.9s ease";
    layer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(${tx}px, ${ty}px) scale(0.5)`;
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 950);
  }
}

/* ---------- UI state ---------- */
let whiteStart = Math.max(0, Math.min(MAX_START, Math.floor(MAX_START / 2)));

const keyboardEl = document.getElementById("keyboard");
const minimapEl = document.getElementById("minimap");
const minimapViewport = document.getElementById("minimap-viewport");
const minimapWrap = document.getElementById("minimap-wrap");
const moleculeToast = document.getElementById("molecule-toast");

function setWhiteStart(v) {
  whiteStart = Math.max(0, Math.min(MAX_START, v));
  renderKeyboard();
  updateMinimapViewport();
}

function renderMinimapStrip() {
  minimapEl.innerHTML = "";
  for (let i = 0; i < WHITE_TOTAL; i++) {
    const d = document.createElement("div");
    d.className = "minimap-key";
    minimapEl.appendChild(d);
  }
}

function updateMinimapViewport() {
  const leftPct = (whiteStart / WHITE_TOTAL) * 100;
  const widthPct = (WHITE_VISIBLE / WHITE_TOTAL) * 100;
  minimapViewport.style.left = `${leftPct}%`;
  minimapViewport.style.width = `${widthPct}%`;
}

function renderKeyboard() {
  keyboardEl.innerHTML = "";
  const slice = WHITE_MIDIS.slice(whiteStart, whiteStart + WHITE_VISIBLE);

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
      recordUserNoteOn(midi);
      spawnFloatingStaffNote(e.clientX, e.clientY, midi);
      w.classList.add("active");
      playNote(midi);
    };
    const up = () => {
      recordUserNoteOff(midi);
      w.classList.remove("active");
      stopNote(midi);
    };

    w.addEventListener("pointerdown", down);
    w.addEventListener("pointerup", up);
    w.addEventListener("pointerleave", up);
    w.addEventListener("pointercancel", up);

    keyboardEl.appendChild(w);
  });

  const whiteW = APP_WIDTH / WHITE_VISIBLE;
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
      recordUserNoteOn(blackMidi);
      spawnFloatingStaffNote(e.clientX, e.clientY, blackMidi);
      b.classList.add("active");
      playNote(blackMidi);
    };
    const up = () => {
      recordUserNoteOff(blackMidi);
      b.classList.remove("active");
      stopNote(blackMidi);
    };

    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointerleave", up);
    b.addEventListener("pointercancel", up);

    keyboardEl.appendChild(b);
  });
}

/* ---------- Nav ---------- */
document.getElementById("step-back").addEventListener("click", () => setWhiteStart(whiteStart - 1));
document.getElementById("step-forward").addEventListener("click", () => setWhiteStart(whiteStart + 1));

minimapWrap.addEventListener("click", (e) => {
  const rect = minimapWrap.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const target = Math.round(x * MAX_START);
  setWhiteStart(target);
});

/* ---------- 点歌（固定曲谱 MIDI，非随机） ---------- */
/** 《小星星》首句：音高与时值按常见 C 大调乐谱简化 */
const TWINKLE_SONG = [
  { m: 60, t: 400 },
  { m: 60, t: 400 },
  { m: 67, t: 400 },
  { m: 67, t: 400 },
  { m: 69, t: 400 },
  { m: 69, t: 400 },
  { m: 67, t: 760 },
  { m: 65, t: 400 },
  { m: 65, t: 400 },
  { m: 64, t: 400 },
  { m: 64, t: 400 },
  { m: 62, t: 400 },
  { m: 62, t: 400 },
  { m: 60, t: 840 },
];

let songUseAuto = false;
let songJobId = 0;
let manualSongIndex = 0;

function cancelAutoSong() {
  songJobId += 1;
}

function updateStatusButton() {
  const b = document.getElementById("btn-status");
  if (b) b.textContent = songUseAuto ? "状态：自动" : "状态：手动";
}

function spawnDemoStaffAtCenter(midi) {
  const stage = document.getElementById("keyboard-stage");
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  spawnFloatingStaffNote(r.left + r.width * 0.5, r.top + r.height * 0.42, midi);
}

function startAutoTwinkle() {
  ensureCtx();
  cancelAutoSong();
  const job = songJobId;
  let delay = 0;
  TWINKLE_SONG.forEach((n) => {
    const startAt = delay;
    setTimeout(() => {
      if (job !== songJobId) return;
      playNote(n.m);
      setTimeout(() => {
        if (job !== songJobId) return;
        stopNote(n.m);
      }, Math.max(90, n.t - 70));
    }, startAt);
    delay += n.t;
  });
}

function playTwinkleManualStep() {
  ensureCtx();
  cancelAutoSong();
  if (manualSongIndex >= TWINKLE_SONG.length) {
    manualSongIndex = 0;
    moleculeToast.textContent = "《小星星》已从头开始。手动模式下每次点「点歌」演奏下一音。";
    moleculeToast.hidden = false;
    clearTimeout(playTwinkleManualStep._toastT);
    playTwinkleManualStep._toastT = setTimeout(() => {
      moleculeToast.hidden = true;
    }, 3200);
  }
  const n = TWINKLE_SONG[manualSongIndex];
  manualSongIndex += 1;
  playNote(n.m);
  spawnDemoStaffAtCenter(n.m);
  setTimeout(() => stopNote(n.m), Math.max(100, n.t - 50));
}

document.getElementById("btn-status").addEventListener("click", () => {
  songUseAuto = !songUseAuto;
  if (!songUseAuto) cancelAutoSong();
  updateStatusButton();
});

document.getElementById("btn-song").addEventListener("click", () => {
  if (songUseAuto) startAutoTwinkle();
  else playTwinkleManualStep();
});

updateStatusButton();

document.getElementById("btn-molecule").addEventListener("click", () => {
  openScoreOverlay();
  const sc = document.getElementById("score-sheet-scroll");
  if (sc) sc.scrollLeft = 0;
});

document.getElementById("score-preview").addEventListener("click", () => {
  previewRecording();
});

document.getElementById("score-send").addEventListener("click", () => {
  confirmSendRecording();
});

document.getElementById("btn-reset").addEventListener("click", () => {
  cancelAutoSong();
  cancelPreviewPlayback();
  manualSongIndex = 0;
  clearUserRecording();
  closeScoreOverlay();
  setWhiteStart(Math.max(0, Math.min(MAX_START, Math.floor(MAX_START / 2))));
  moleculeToast.hidden = true;
  for (const m of [...activeOsc.keys()]) {
    stopNote(m);
  }
  document.querySelectorAll(".white-key.active, .black-key.active").forEach((el) => {
    el.classList.remove("active");
  });
});

/* ---------- 接收外部分子音乐（SMILES → 分子到音乐 → 自动演奏） ---------- */
let pendingMoleculeMusic = null;

function showMoleculeMusicPrompt(smiles, midiEvents) {
  const toast = document.getElementById("molecule-toast");
  if (!toast) return;
  toast.innerHTML = `<div>接收到分子音乐信息<br><small>${smiles}</small><br><button id="mol-music-yes" style="margin-top:6px;padding:4px 12px;border-radius:4px;border:none;background:#4a7c59;color:#fff;cursor:pointer;">开始演奏</button></div>`;
  toast.hidden = false;
  document.getElementById("mol-music-yes").addEventListener("click", () => {
    toast.hidden = true;
    enterAutoPlayFromMidiEvents(midiEvents);
  }, { once: true });
}

function enterAutoPlayFromMidiEvents(midiEvents) {
  songUseAuto = true;
  updateStatusButton();
  cancelAutoSong();
  const job = songJobId;
  midiEvents.forEach((ev) => {
    const startAt = ev.time;
    setTimeout(() => {
      if (job !== songJobId) return;
      playNote(ev.note, (ev.velocity || 90) / 127);
      spawnDemoStaffAtCenter(ev.note);
      setTimeout(() => {
        if (job !== songJobId) return;
        stopNote(ev.note);
      }, Math.max(50, ev.duration - 20));
    }, startAt);
  });
  const last = midiEvents[midiEvents.length - 1];
  const total = (last ? last.time + last.duration : 0) + 800;
  setTimeout(() => {
    if (job !== songJobId) return;
    songUseAuto = false;
    updateStatusButton();
    moleculeToast.textContent = "分子音乐演奏结束，可手动弹奏";
    moleculeToast.hidden = false;
    setTimeout(() => { moleculeToast.hidden = true; }, 3000);
  }, total);
}

// 模拟接收外部 SMILES（实际应由后端推送或轮询）
function mockReceiveMoleculeMusic(smiles) {
  setApiStatus("moleculeToMusic", "sending");
  fetch(`${API_BASE}/api/molecule_to_music`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ smiles, bpm: 100 }),
  })
    .then((r) => r.json())
    .then((data) => {
      setApiStatus("moleculeToMusic", "online");
      if (data.ok && data.midi_events && data.midi_events.length) {
        showMoleculeMusicPrompt(data.meta.smiles || smiles, data.midi_events);
      }
    })
    .catch(() => setApiStatus("moleculeToMusic", "offline"));
}

/* ---------- API 状态监控 ---------- */
const apiStatus = {
  musicToMolecule: "offline",
  moleculeToMusic: "offline",
};

function setApiStatus(key, status) {
  apiStatus[key] = status;
  const dotId = key === "musicToMolecule" ? "status-m2m" : "status-mol";
  const dot = document.getElementById(dotId);
  if (!dot) return;
  dot.className = "api-status-dot " + status;
}

async function checkApiHealth() {
  setApiStatus("musicToMolecule", "connecting");
  try {
    const resp = await fetch(`${API_BASE}/api/music_to_molecule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ note: 60, start: 0, duration: 100 }], bpm: 100 }),
    });
    if (resp.ok) setApiStatus("musicToMolecule", "online");
    else setApiStatus("musicToMolecule", "offline");
  } catch {
    setApiStatus("musicToMolecule", "offline");
  }

  setApiStatus("moleculeToMusic", "connecting");
  try {
    const resp = await fetch(`${API_BASE}/api/molecule_to_music`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smiles: "CCO", bpm: 100 }),
    });
    if (resp.ok) setApiStatus("moleculeToMusic", "online");
    else setApiStatus("moleculeToMusic", "offline");
  } catch {
    setApiStatus("moleculeToMusic", "offline");
  }
}

checkApiHealth();
setInterval(checkApiHealth, 15000);

/* ---------- Boot ---------- */
initPianoEmbedUnified();
verifyPianoRange();
renderMinimapStrip();
renderKeyboard();
updateMinimapViewport();

document.body.addEventListener("click", () => ensureCtx(), { once: true });
