// PianoMol - 虚拟钢琴模拟器
// Developed by MusicMol Team
// 功能: 88键钢琴, 滑动触控, 炊烟动画, MIDI本地保存

class Piano {
    constructor(opts = {}) {
        this.isPrimaryPiano = opts.isPrimaryPiano !== false;
        this.canvasId = opts.canvasId || 'piano3dCanvas';
        this.keyboardElId = opts.keyboardElId || 'keyboard';
        this.notesRange = opts.notesRange || 'standard';
        this.showDimOverlay = !!opts.showDimOverlay;
        this.dimOuterSelector = opts.dimOuterSelector || '#pianoMainOuter';
        this.dimIdPrefix = opts.dimIdPrefix || 'ext';
        this.keyStandard = opts.keyStandard === 'gb' ? 'gb' : 'legacy';

        this.viewer3d = null;

        this.audioContext = null;
        this.masterVolume = 0.5;
        this.sustainEnabled = false;
        this.showHints = false;
        this.activeNotes = new Map();
        this.sustainedNotes = new Set();
        this.notes = this.notesRange === 'extended' ? this.generateNotesExtended() : this.generateNotesStandard();

        // MIDI录制相关
        this.recordedNotes = [];
        this.isRecording = false;
        // this.recordingStartTime = null;
        this.recordingStartTime = 0;
        // this.lastNoteTime = null;
        this.lastNoteTime = 0;
        this.recordingTimeout = null;
        this.activeNoteTimes = new Map(); // 记录每个音符的开始时间

        // 触摸滑动相关
        this.touchedKeys = new Set();
        this.isTouching = false;

        // 自动演奏相关
        this.isPlaying = false;
        this.playbackTimeouts = [];
        this.currentPlaybackNotes = new Set();

        // 实时 Music -> Fragment 映射相关（仅主钢琴参与）
        this.liveMappingEnabled = opts.liveMappingEnabled !== undefined
            ? !!opts.liveMappingEnabled
            : this.isPrimaryPiano;
        this.liveEvents = []; // 已完成的音符 {start:ms, duration:ms, note:midi}
        this.liveActiveMap = new Map(); // 正在按下的 note -> startTime(ms)
        this.liveStartTime = null; // 第一个 live 事件的时间基准
        this.liveUpdateTimer = null; // debounce timer

        /** 演奏模式：mouse = 画布/指针；api = 仅通过 MusicMolPiano 接口驱动，画布不拾音 */
        this.playMode = opts.playMode === 'api' ? 'api' : 'mouse';

        /** MIDI 交换协议 v1（POST /api/midi_exchange） */
        this.midiExchangeSequence = 0;
        this.midiExchangeSessionId = 'sess-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);

        /** 五线谱渲染器 */
        this.staffRenderer = null;
        if (typeof window.StaffRenderer !== 'undefined') {
            this.staffRenderer = new window.StaffRenderer('staffSvg', { maxNotes: 32 });
        }

        this.init();
    }

    _getMidiExchangeBaseUrl() {
        const inp = document.getElementById('midiExchangeBaseUrl');
        const raw = inp && inp.value && inp.value.trim ? inp.value.trim() : '';
        if (raw) return raw.replace(/\/$/, '');
        if (typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:')) {
            const p = location.port || (location.protocol === 'https:' ? '443' : '80');
            const host = location.hostname || '127.0.0.1';
            const proto = location.protocol === 'https:' ? 'https:' : 'http:';
            // 8766：PAINOJS 映射端口；API 指向同机 MusicMol 5020
            if (p === '8081' || p === '8766') return `${proto}//${host}:5020`.replace(/\/$/, '');
            if (p === '5020') return (location.origin || '').replace(/\/$/, '');
            return `${proto}//${host}:5020`.replace(/\/$/, '');
        }
        return 'http://127.0.0.1:5020';
    }

    _midiExchangeEnabled() {
        const cb = document.getElementById('midiExchangeEnabled');
        if (!cb) return true;
        return !!cb.checked;
    }

    _midiExchangeSetStatus(text, isError) {
        const el = document.getElementById('midiExchangeLastStatus');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('midi-exchange-status--error', !!isError);
    }

    /**
     * 按 MIDI_EXCHANGE_PROTOCOL_V1 发送单条事件（note_on / note_off / control_change 等）
     */
    _sendMidiExchange(midi) {
        if (!this._midiExchangeEnabled()) return;
        if (this.playMode === 'api') return;
        this.midiExchangeSequence += 1;
        const now = Date.now();
        const base = this._getMidiExchangeBaseUrl();
        const ts = midi && midi.timestamp != null ? midi.timestamp : now;
        const body = {
            protocol: 'midi-exchange-v1',
            source: 'musicmol_piano',
            session_id: this.midiExchangeSessionId,
            sequence: this.midiExchangeSequence,
            sent_at: now,
            midi: Object.assign({}, midi, { timestamp: ts }),
            meta: {
                device_id: 'musicmol-web-piano',
                performer: 'browser',
            },
        };
        fetch(base + '/api/midi_exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            mode: 'cors',
        })
            .then((r) => {
                if (!r.ok) {
                    return r.text().then((t) => {
                        throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 120) : ''));
                    });
                }
                return r.json().catch(() => ({}));
            })
            .then((data) => {
                const id = data && data.event_id != null ? '#' + data.event_id : '';
                this._midiExchangeSetStatus('已发送 ' + id, false);
            })
            .catch((err) => {
                const msg = (err && err.message) || String(err);
                console.warn('[MIDI exchange] POST 失败', base, msg);
                this._midiExchangeSetStatus('发送失败：' + msg, true);
            });
    }

    generateNotesStandard() {
        const notes = [];
        const noteSequence = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        let midiNote = 48;
        const startOctave = 3;
        const endOctave = 6;

        for (let octave = startOctave; octave <= endOctave; octave++) {
            for (let i = 0; i < noteSequence.length; i++) {
                const noteName = noteSequence[i];
                if (octave === 6 && ['F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].includes(noteName)) break;

                const freq = 32.70 * Math.pow(2, (octave - 1) + i / 12);
                notes.push({
                    note: noteName,
                    octave: octave,
                    freq: freq,
                    isBlack: noteName.includes('#'),
                    midiNote: midiNote++
                });
            }
        }
        return notes;
    }

    generateNotesExtended() {
        const notes = [];
        const noteSequence = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        let midiNote = 24;
        const startOctave = 1;
        const endOctave = 6;

        for (let octave = startOctave; octave <= endOctave; octave++) {
            for (let i = 0; i < noteSequence.length; i++) {
                const noteName = noteSequence[i];
                if (octave === 6 && ['F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].includes(noteName)) break;

                const freq = 32.70 * Math.pow(2, (octave - 1) + i / 12);
                notes.push({
                    note: noteName,
                    octave: octave,
                    freq: freq,
                    isBlack: noteName.includes('#'),
                    midiNote: midiNote++
                });
            }
        }
        return notes;
    }

    get keyboardMap() {
        if (this.notesRange === 'extended') return {};
        return {
            'q': 'C5', 'w': 'D5', 'e': 'E5', 'r': 'F5', 't': 'G5', 'y': 'A5', 'u': 'B5',
            'a': 'C4', 's': 'D4', 'd': 'E4', 'f': 'F4', 'g': 'G4', 'h': 'A4', 'j': 'B4',
            'z': 'C3', 'x': 'D3', 'c': 'E3', 'v': 'F3', 'b': 'G3', 'n': 'A3', 'm': 'B3',
            'i': 'E6'
        };
    }

    // 初始化
    init() {
        this.createKeyboard();
        this.setupEventListeners();
        console.log('🎹 PianoMol initialized by MusicMol Team!');
    }

    // 初始化 Web Audio API
    initAudio() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        return this.audioContext;
    }

    /**
     * 解除浏览器自动播放限制：须在用户点击等手势后调用一次；异步播放前也应 await。
     * @returns {Promise<void>}
     */
    unlockAudio() {
        const ctx = this.initAudio();
        if (!ctx) return Promise.resolve();
        if (ctx.state === 'closed') {
            this.audioContext = null;
            return this.unlockAudio();
        }
        if (ctx.state === 'suspended') return ctx.resume().catch(() => {});
        return Promise.resolve();
    }

    // 创建钢琴音色 (支持毫秒级精准的未来时间调度)
    playNote(frequency, duration = 2.0, scheduledTime = null) {
        this.initAudio();
        const ctx = this.audioContext;

        // 核心：使用传入的预定时间，如果没有则立即播放（+0.01s 缓冲防爆音）
        const time = scheduledTime !== null ? scheduledTime : ctx.currentTime + 0.01;

        const baseVelocity = this.masterVolume * 0.6;
        let bassBoost = 1.0;
        if (frequency < 110) bassBoost = 1.9;
        else if (frequency < 220) bassBoost = 1.4;
        const velocity = Math.min(baseVelocity * bassBoost, 1.0);

        // 创建节点
        const oscillator = ctx.createOscillator();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, time);

        const harmonics = ctx.createOscillator();
        harmonics.type = 'sine';
        harmonics.frequency.setValueAtTime(frequency * 2, time);

        const harmonics2 = ctx.createOscillator();
        harmonics2.type = 'sine';
        harmonics2.frequency.setValueAtTime(frequency * 3, time);

        const harmonics3 = ctx.createOscillator();
        harmonics3.type = 'sine';
        harmonics3.frequency.setValueAtTime(frequency * 4, time);

        const subHarmonic = ctx.createOscillator();
        subHarmonic.type = 'sine';
        subHarmonic.frequency.setValueAtTime(frequency * 0.5, time);

        const gainNode = ctx.createGain();
        const harmonicsGain = ctx.createGain();
        const harmonics2Gain = ctx.createGain();
        const harmonics3Gain = ctx.createGain();
        const subHarmonicGain = ctx.createGain();

        const pannerLeft = ctx.createStereoPanner();
        pannerLeft.pan.setValueAtTime(-0.3, time);
        const pannerRight = ctx.createStereoPanner();
        pannerRight.pan.setValueAtTime(0.3, time);
        const pannerCenter = ctx.createStereoPanner();
        pannerCenter.pan.setValueAtTime(0, time);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(Math.max(frequency * 8, 400), time);
        filter.Q.setValueAtTime(1, time);

        // 极限干脆的 ADSR 包络
        const attack = 0.005;
        const decay = 0.15;
        const sustain = 0.25;
        const release = 0.02;   // 极速收音

        gainNode.gain.setValueAtTime(0, time);
        gainNode.gain.linearRampToValueAtTime(velocity, time + attack);
        gainNode.gain.exponentialRampToValueAtTime(velocity * sustain, time + attack + decay);
        gainNode.gain.setValueAtTime(velocity * sustain, time + duration - release);
        gainNode.gain.exponentialRampToValueAtTime(0.001, time + duration);

        harmonicsGain.gain.setValueAtTime(0, time);
        harmonicsGain.gain.linearRampToValueAtTime(velocity * 0.2, time + attack);
        harmonicsGain.gain.exponentialRampToValueAtTime(0.001, time + duration * 0.6);

        harmonics2Gain.gain.setValueAtTime(0, time);
        harmonics2Gain.gain.linearRampToValueAtTime(velocity * 0.12, time + attack);
        harmonics2Gain.gain.exponentialRampToValueAtTime(0.001, time + duration * 0.5);

        harmonics3Gain.gain.setValueAtTime(0, time);
        harmonics3Gain.gain.linearRampToValueAtTime(velocity * 0.06, time + attack);
        harmonics3Gain.gain.exponentialRampToValueAtTime(0.001, time + duration * 0.4);

        subHarmonicGain.gain.setValueAtTime(0, time);
        subHarmonicGain.gain.linearRampToValueAtTime(velocity * 0.15, time + attack * 2);
        subHarmonicGain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        // 连接链路 (无混响直达声)
        oscillator.connect(gainNode);
        gainNode.connect(pannerCenter);
        pannerCenter.connect(filter);

        harmonics.connect(harmonicsGain);
        harmonicsGain.connect(pannerLeft);
        pannerLeft.connect(filter);

        harmonics2.connect(harmonics2Gain);
        harmonics2Gain.connect(pannerRight);
        pannerRight.connect(filter);

        harmonics3.connect(harmonics3Gain);
        harmonics3Gain.connect(pannerLeft);
        pannerLeft.connect(filter);

        subHarmonic.connect(subHarmonicGain);
        subHarmonicGain.connect(pannerCenter);
        pannerCenter.connect(filter);

        filter.connect(ctx.destination);

        // 在预定时间启动和停止
        oscillator.start(time);
        harmonics.start(time);
        harmonics2.start(time);
        harmonics3.start(time);
        subHarmonic.start(time);

        oscillator.stop(time + duration);
        harmonics.stop(time + duration);
        harmonics2.stop(time + duration);
        harmonics3.stop(time + duration);
        subHarmonic.stop(time + duration);

        return { gainNode };
    }

    // 键盘 UI：941×264 内由 Three.js（piano3d-941.js）渲染，DOM 键隐藏
    createKeyboard() {
        const keyboard = document.getElementById(this.keyboardElId);
        if (keyboard) {
            keyboard.innerHTML = '';
            keyboard.style.display = 'none';
        }
        const canvas = document.getElementById(this.canvasId);
        if (canvas && typeof window.createPiano941Viewer === 'function') {
            this.viewer3d = window.createPiano941Viewer();
            this.viewer3d.init(canvas, this, { keyStandard: this.keyStandard });
            if (this.showDimOverlay) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => this.updatePianoDimensionOverlays());
                });
                if (!window.__pianoDimResizeBound) {
                    window.__pianoDimResizeBound = true;
                    window.addEventListener('resize', () => {
                        if (window.piano && window.piano.showDimOverlay) window.piano.updatePianoDimensionOverlays();
                    });
                }
            }
        }
    }

    updatePianoDimensionOverlays() {
        if (!this.showDimOverlay) return;
        const outer = document.querySelector(this.dimOuterSelector);
        if (outer) {
            const cs = getComputedStyle(outer);
            const pl = Math.round(parseFloat(cs.paddingLeft) || 0);
            const pr = Math.round(parseFloat(cs.paddingRight) || 0);
            const pt = Math.round(parseFloat(cs.paddingTop) || 0);
            const pb = Math.round(parseFloat(cs.paddingBottom) || 0);
            const padEl = document.getElementById(`${this.dimIdPrefix}DimOuterPad`);
            if (padEl) {
                padEl.textContent = `外框与内部视口间隙 左 ${pl} px · 右 ${pr} px · 上 ${pt} px · 下 ${pb} px`;
            }
        }
        const px = this.viewer3d && typeof this.viewer3d.getLayoutPixelSizes === 'function'
            ? this.viewer3d.getLayoutPixelSizes()
            : null;
        const set = (suffix, text) => {
            const n = document.getElementById(`${this.dimIdPrefix}${suffix}`);
            if (n) n.textContent = text;
        };
        if (!px) {
            set('DimMarginL', '—');
            set('DimMarginR', '—');
            set('DimMarginTop', '—');
            set('DimMarginBot', '—');
            set('DimWhiteKey', '—');
            set('DimBlackKey', '—');
            set('DimKeyRegion', '—');
            set('DimKeyStats', '—');
            set('DimStripLabel', '当前为全幅键区画布，无顶栏');
            set('DimGbNote', '—');
            if (this.dimIdPrefix === 'ext') set('DimNewOctave', '—');
            return;
        }
        set('DimStripLabel', `画布 ${px.canvasCssW}×${px.canvasCssH} px（与当前画布 CSS 尺寸一致）；四边空档相对整块画布计`);
        const wEl = document.getElementById(`${this.dimIdPrefix}DimCssW`);
        const hEl = document.getElementById(`${this.dimIdPrefix}DimCssH`);
        const outEl = document.getElementById(`${this.dimIdPrefix}DimCssOut`);
        if (wEl) wEl.textContent = `宽 ${px.canvasCssW} px`;
        if (hEl) hEl.textContent = `高 ${px.canvasCssH} px`;
        if (outEl) outEl.textContent = `输出 ${px.canvasCssW} × ${px.canvasCssH}`;
        set('DimMarginL', `左空 ${px.marginX} px`);
        set('DimMarginR', `右空 ${px.marginX} px`);
        if (typeof px.marginTopPx === 'number' && typeof px.marginBotPx === 'number') {
            set('DimMarginTop', `上空 ${px.marginTopPx} px`);
            set('DimMarginBot', `下空 ${px.marginBotPx} px`);
        } else {
            set('DimMarginTop', `上空 ${px.marginY} px`);
            set('DimMarginBot', `下空 ${px.marginY} px`);
        }
        set('DimWhiteKey', `白键 宽 ${px.whiteWpx} × 深 ${px.whiteDpx} px（屏上像素）`);
        set('DimBlackKey', `黑键 宽 ${px.blackWpx} × 深 ${px.blackDpx} px（屏上像素）`);
        set('DimKeyRegion', `键列外包约 ${px.keysWPx} × ${px.keysHPx} px`);
        set(
            'DimKeyStats',
            `共 ${px.totalKeys} 键（白 ${px.whiteKeyCount} / 黑 ${px.blackKeyCount}），单白键宽约 ${px.whiteWpx} px`
        );
        if (this.dimIdPrefix === 'main') {
            set('DimGbNote', '主钢琴：键比例为通用三维示意；上列为画布内像素推算。下方扩展块按国标（GB/T 10159-2023、QB/T 4131-2010）典型毫米中值建模。');
        } else {
            set('DimNewOctave', '音域 C1–E6，约合 5⅓ 个八度。');
            set('DimGbNote', 'GB/T 10159-2023《钢琴》引用 QB/T 4131 键宽系列等：白键宽 23.5 mm、高约 22 mm；白键下缘（演奏端）至黑键前沿 50–52 mm（取 51），沿键深方向，≠ 白黑键「全长差」约 150−95 mm（屏上白键在演奏端多出一截属后者）。黑键靠里、白键朝演奏者。三维白键深约 150 mm；黑底宽 11.75 mm、长 95 mm、高出白键约 11.75 mm。88 键总宽约 1224 mm。');
        }
    }

    // 创建音符飘动动画：WebGL 在钢琴外 #musicMolFxZone；DOM 模式需 keyElement
    createNoteParticle(noteName, keyElement, spawnHint) {
        const container = document.getElementById('noteParticles');
        if (!container) return;

        const w3d = typeof NoteConfig !== 'undefined' ? NoteConfig.webGL3D : null;
        const hint = keyElement || spawnHint;
        if (w3d && w3d.enabled && window.MusicMolFX3D && window.MusicMolFX3D.ready && hint) {
            const spawned = window.MusicMolFX3D.spawn(noteName, hint, container);
            if (spawned && w3d.skipDomParticles) {
                if (NoteConfig.splashConfig && NoteConfig.splashConfig.enabled && spawnHint) {
                    const cr = container.getBoundingClientRect();
                    const u = (spawnHint.keyIndex + 0.5) / Math.max(1, spawnHint.totalKeys || this.notes.length);
                    const splashRgb = spawnHint.fromApi ? 'rgba(110, 200, 255, 0.92)' : 'rgba(200, 200, 210, 0.9)';
                    this.createSplashEffect(
                        u * cr.width,
                        Math.max(20, cr.height - 40),
                        container,
                        splashRgb
                    );
                } else if (NoteConfig.splashConfig && NoteConfig.splashConfig.enabled && keyElement) {
                    const rect = keyElement.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    const isBlackKey = keyElement.classList.contains('black-key');
                    const labelOffset = isBlackKey ? 165 : 270;
                    const keyTop = rect.top - containerRect.top;
                    this.createSplashEffect(
                        rect.left - containerRect.left + rect.width / 2,
                        keyTop + labelOffset,
                        container,
                        'rgba(200, 200, 210, 0.9)'
                    );
                }
                return;
            }
        }

        if (!keyElement) return;

        const rect = keyElement.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const particle = document.createElement('div');
        particle.className = 'note-particle';

        const startY = NoteConfig.animationConfig.startY;
        const keyTop = rect.top - containerRect.top;

        particle.style.left = (rect.left - containerRect.left + rect.width / 2) + 'px';
        particle.style.top = (keyTop + startY) + 'px';

        this.setParticleContent(particle, noteName);

        particle.style.animationDuration = NoteConfig.animationConfig.duration + 's';

        container.appendChild(particle);

        if (NoteConfig.splashConfig.enabled) {
            const isBlackKey = keyElement.classList.contains('black-key');
            const labelOffset = isBlackKey ? 165 : 270;

            this.createSplashEffect(
                rect.left - containerRect.left + rect.width / 2,
                keyTop + labelOffset,
                container,
                particle.style.color
            );
        }

        setTimeout(() => {
            particle.remove();
        }, NoteConfig.animationConfig.duration * 1000);
    }

    // 根据配置设置粒子内容
    setParticleContent(particle, noteName) {
        const config = NoteConfig || {};

        // 优先：如果 specialAtomConfig 启用且 noteName 在 targetPitches 中，则显示原子 emoji + 名称
        try {
            const special = config.specialAtomConfig || {};
            if (special.enabled) {
                // 生成 branch 映射（从 backbone 把 5->4）
                const backbone = special.pitchMapBackbone || {};
                const branch = {};
                Object.keys(backbone).forEach(k => {
                    const p = backbone[k];
                    if (typeof p === 'string') branch[k] = p.replace('5', '4');
                });

                // 反向映射 pitch -> [elements]
                const reverse = {};
                function addReverse(m) {
                    Object.entries(m || {}).forEach(([el, pitch]) => {
                        if (!pitch) return;
                        if (!reverse[pitch]) reverse[pitch] = [];
                        reverse[pitch].push(el);
                    });
                }
                addReverse(backbone);
                addReverse(branch);

                const targets = Array.isArray(special.targetPitches) ? special.targetPitches : [];

                if (targets.includes(noteName)) {
                    const elements = reverse[noteName] || [];
                    if (Array.isArray(elements) && elements.length > 0) {
                        const primary = elements[0];
                        const emojiMap = special.atomEmoji || {};
                        const nameMap = special.atomName || {};

                        // 构建显示节点
                        particle.innerHTML = '';
                        const wrap = document.createElement('div');
                        wrap.style.display = 'flex';
                        wrap.style.flexDirection = 'column';
                        wrap.style.alignItems = 'center';
                        wrap.style.justifyContent = 'center';
                        wrap.style.pointerEvents = 'none';

                        const emojiEl = document.createElement('div');
                        emojiEl.textContent = emojiMap[primary] || '⚛️';
                        emojiEl.style.fontSize = '2.2rem';
                        emojiEl.style.lineHeight = '1';
                        emojiEl.style.marginBottom = '4px';
                        emojiEl.style.filter = 'drop-shadow(0 2px 6px rgba(0,0,0,0.35))';

                        const infoEl = document.createElement('div');
                        // 判断是主链(5)还是支链(4)
                        const noteMatch = noteName.match(/^([A-G]#?)(\d+)$/);
                        let chainLabel = '';
                        if (noteMatch) {
                            const octave = parseInt(noteMatch[2], 10);
                            if (octave === 4) chainLabel = '支链';
                            else if (octave === 5) chainLabel = '主链';
                        }
                        infoEl.textContent = `${primary} · ${nameMap[primary] || ''}${chainLabel ? ' · ' + chainLabel : ''}`;
                        infoEl.style.fontSize = '0.9rem';
                        infoEl.style.fontWeight = '600';
                        infoEl.style.color = 'rgba(0,0,0,0.85)';
                        infoEl.style.background = 'rgba(255,255,255,0.85)';
                        infoEl.style.padding = '2px 6px';
                        infoEl.style.borderRadius = '8px';
                        infoEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.12)';

                        wrap.appendChild(emojiEl);
                        wrap.appendChild(infoEl);

                        // 不再显示 "+N other" 的额外提示，直接只显示首要元素信息

                        particle.appendChild(wrap);
                        return; // 已处理，返回
                    }
                }
            }
        } catch (e) {
            // 保护性捕获：如果 special 配置有问题，静默回退到默认显示逻辑
            console.error('specialAtomConfig handling error:', e);
        }

        // 默认显示逻辑（依据 NoteConfig.displayMode）
        switch (config.displayMode) {
            case 'firework':
                this.createFireworkEffect(particle, noteName);
                break;

            case 'text':
                if (config.textConfig.content === 'noteName') {
                    particle.textContent = noteName;
                } else {
                    // 随机选择自定义文本
                    const texts = config.textConfig.customTexts;
                    particle.textContent = texts[Math.floor(Math.random() * texts.length)];
                }
                particle.style.fontSize = config.textConfig.fontSize;
                particle.style.fontWeight = config.textConfig.fontWeight;

                // 设置颜色
                if (config.textConfig.colorMode === 'random') {
                    const colors = config.textConfig.colors;
                    particle.style.color = colors[Math.floor(Math.random() * colors.length)];
                } else if (config.textConfig.colorMode === 'fixed') {
                    particle.style.color = config.textConfig.fixedColor;
                } else if (config.textConfig.colorMode === 'gradient') {
                    // 渐变色实现
                    particle.style.background = `linear-gradient(135deg, ${config.textConfig.gradientColors.join(', ')})`;
                    particle.style.webkitBackgroundClip = 'text';
                    particle.style.webkitTextFillColor = 'transparent';
                }
                break;

            case 'emoji':
                const emojis = config.emojiConfig.emojis || [];
                particle.textContent = config.emojiConfig.random
                    ? emojis[Math.floor(Math.random() * emojis.length)]
                    : emojis[0] || '';
                particle.style.fontSize = config.emojiConfig.size;
                break;

            case 'image':
                const images = config.imageConfig.images || [];
                const imgSrc = config.imageConfig.random
                    ? images[Math.floor(Math.random() * images.length)]
                    : images[0];

                if (imgSrc) {
                    const img = document.createElement('img');
                    img.src = imgSrc;
                    img.style.width = config.imageConfig.width;
                    img.style.height = config.imageConfig.height;
                    if (config.imageConfig.keepRatio) {
                        img.style.objectFit = 'contain';
                    }
                    particle.appendChild(img);
                }
                break;

            case 'custom':
                if (config.customConfig && typeof config.customConfig.generateHTML === 'function') {
                    particle.innerHTML = config.customConfig.generateHTML(noteName);
                }

                // 注入自定义CSS (如果还没有注入)
                if (!document.getElementById('custom-note-css') && config.customConfig && config.customConfig.customCSS) {
                    const style = document.createElement('style');
                    style.id = 'custom-note-css';
                    style.textContent = config.customConfig.customCSS;
                    document.head.appendChild(style);
                }
                break;
        }
    }

    // 创建彩虹烟花效果
    createFireworkEffect(particle, noteName) {
        const config = NoteConfig.fireworkConfig;

        // 如果显示音符名称
        if (config.showNoteName) {
            const noteText = document.createElement('div');
            noteText.className = 'firework-note';
            noteText.textContent = noteName;
            noteText.style.fontSize = config.noteNameStyle.fontSize;
            noteText.style.fontWeight = config.noteNameStyle.fontWeight;

            // 彩虹文字效果
            if (config.noteNameStyle.color === 'rainbow') {
                const rainbowGradient = `linear-gradient(135deg, ${config.rainbowColors.join(', ')})`;
                noteText.style.background = rainbowGradient;
                noteText.style.webkitBackgroundClip = 'text';
                noteText.style.webkitTextFillColor = 'transparent';
                noteText.style.backgroundClip = 'text';
            } else {
                noteText.style.color = config.noteNameStyle.color;
            }

            if (config.noteNameStyle.glow) {
                noteText.style.filter = 'drop-shadow(0 0 10px currentColor)';
            }

            particle.appendChild(noteText);
        }

        // 创建烟花粒子容器
        const fireworkContainer = document.createElement('div');
        fireworkContainer.className = 'firework-particles';
        fireworkContainer.style.position = 'absolute';
        fireworkContainer.style.top = '0';
        fireworkContainer.style.left = '0';
        fireworkContainer.style.width = '100%';
        fireworkContainer.style.height = '100%';
        particle.appendChild(fireworkContainer);

        // 创建彩虹烟花粒子
        for (let i = 0; i < config.particleCount; i++) {
            setTimeout(() => {
                this.createFireworkParticle(
                    fireworkContainer,
                    i,
                    config
                );
            }, i * 30); // 延迟创建,产生绽放效果
        }
    }

    // 创建单个烟花粒子
    createFireworkParticle(container, index, config) {
        const particle = document.createElement('div');
        particle.className = 'firework-particle';

        // 粒子样式
        particle.style.position = 'absolute';
        particle.style.width = config.particleSize + 'px';
        particle.style.height = config.particleSize + 'px';
        particle.style.borderRadius = '50%';
        particle.style.top = '50%';
        particle.style.left = '50%';
        particle.style.transform = 'translate(-50%, -50%)';
        particle.style.pointerEvents = 'none';

        // 彩虹颜色
        const colorIndex = index % config.rainbowColors.length;
        const color = config.rainbowColors[colorIndex];

        if (config.sparkle) {
            particle.style.background = `radial-gradient(circle, ${color} 0%, ${color}88 50%, transparent 100%)`;
            particle.style.boxShadow = `0 0 ${config.particleSize * 2}px ${color}, 0 0 ${config.particleSize}px ${color}`;
        } else {
            particle.style.background = color;
        }

        // 计算爆炸方向
        const angle = (Math.PI * 2 * index) / config.particleCount;
        const distance = config.explosionRadius + Math.random() * 20;
        const tx = Math.cos(angle) * distance;
        const ty = Math.sin(angle) * distance;

        // 粒子动画
        particle.style.setProperty('--tx', tx + 'px');
        particle.style.setProperty('--ty', ty + 'px');

        const duration = 0.8 + Math.random() * 0.4;
        particle.style.animation = `fireworkExplode ${duration}s ease-out forwards`;

        // 拖尾效果
        if (config.trail) {
            particle.style.boxShadow = `
                0 0 ${config.particleSize * 3}px ${color},
                0 0 ${config.particleSize * 2}px ${color},
                0 0 ${config.particleSize}px ${color}
            `;
        }

        container.appendChild(particle);

        // 二次爆炸效果
        if (config.secondBurst && Math.random() > 0.7) {
            setTimeout(() => {
                this.createSecondBurst(particle, color, config.particleSize);
            }, duration * 500);
        }

        // 清理
        setTimeout(() => {
            particle.remove();
        }, duration * 1000 + 200);
    }

    // 二次爆炸效果
    createSecondBurst(parentParticle, color, size) {
        const miniParticles = 3;
        for (let i = 0; i < miniParticles; i++) {
            const mini = document.createElement('div');
            mini.style.position = 'absolute';
            mini.style.width = (size / 2) + 'px';
            mini.style.height = (size / 2) + 'px';
            mini.style.borderRadius = '50%';
            mini.style.background = color;
            mini.style.top = '50%';
            mini.style.left = '50%';
            mini.style.opacity = '0.8';

            const angle = (Math.PI * 2 * i) / miniParticles;
            const dist = 15 + Math.random() * 10;
            mini.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
            mini.style.setProperty('--ty', Math.sin(angle) * dist + 'px');
            mini.style.animation = 'fireworkExplode 0.4s ease-out forwards';

            parentParticle.appendChild(mini);

            setTimeout(() => mini.remove(), 400);
        }
    }

    // 创建水花效果
    createSplashEffect(x, y, container, noteColor) {
        const config = NoteConfig.splashConfig;
        const particleCount = config.particleCount;

        for (let i = 0; i < particleCount; i++) {
            const splash = document.createElement('div');
            splash.className = 'splash-particle';
            splash.style.left = x + 'px';
            splash.style.top = y + 'px';
            splash.style.width = config.particleSize + 'px';
            splash.style.height = config.particleSize + 'px';

            // 使用音符颜色或固定颜色
            if (!config.useNoteColor) {
                splash.style.background = `radial-gradient(circle, ${config.fixedColor} 0%, transparent 70%)`;
            }

            const angle = (Math.PI * 2 * i) / particleCount;
            const distance = Math.random() * config.spreadDistance;
            const tx = Math.cos(angle) * distance;
            const ty = Math.sin(angle) * distance;

            splash.style.setProperty('--tx', tx + 'px');
            splash.style.setProperty('--ty', ty + 'px');
            splash.style.animation = `splash ${config.duration}s ease-out forwards`;

            container.appendChild(splash);

            setTimeout(() => {
                splash.remove();
            }, config.duration * 1000);
        }
    }

    // 开始播放音符
    startNote(index, keyElement) {
        const noteData = this.notes[index];

        // 【关键修复】如果上一个同音高的音还在响，强制瞬间掐断它，绝对不吞音！
        if (this.activeNotes.has(index)) {
            this.stopNote(index);
        }
        // if (this.activeNotes.has(index)) return;

        const duration = this.sustainEnabled ? 4.0 : 2.0;
        const audioNodes = this.playNote(noteData.freq, duration);
        this.activeNotes.set(index, audioNodes);

        const key = keyElement || document.querySelector(`[data-index="${index}"]`);
        if (key) {
            key.classList.add('active');
            this.createNoteParticle(noteData.note + noteData.octave, key);
        } else {
            if (this.viewer3d && this.viewer3d.ready) {
                this.viewer3d.setKeyVisual(index, true);
            }
            this.createNoteParticle(noteData.note + noteData.octave, null, {
                keyIndex: index,
                totalKeys: this.notes.length,
            });
        }

        if (this.sustainEnabled) {
            this.sustainedNotes.add(index);
        }

        this.updateNoteDisplay(noteData.note + noteData.octave);

        // 记录MIDI音符开始(带上键的引用用于后续处理)
        this.recordNoteOn(noteData.midiNote, index);

        this._sendMidiExchange({
            type: 'note_on',
            note: noteData.midiNote,
            velocity: Math.min(127, Math.max(1, Math.round(40 + this.masterVolume * 87))),
            channel: 0,
            timestamp: Date.now(),
        });

        // 实时映射：记录 live note on（不依赖于 isRecording）
        try {
            this._liveNoteOn(noteData.midiNote);
        } catch (err) {
            console.warn('liveNoteOn error', err);
        }
    }

    // 停止播放音符
    stopNote(index) {
        if (this.sustainEnabled && this.sustainedNotes.has(index)) return;

        const audioNodes = this.activeNotes.get(index);
        if (audioNodes) {
            const ctx = this.audioContext;
            const now = ctx.currentTime;

            audioNodes.gainNode.gain.cancelScheduledValues(now);
            audioNodes.gainNode.gain.setValueAtTime(audioNodes.gainNode.gain.value, now);
            audioNodes.gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

            this.activeNotes.delete(index);
        }

        const key = document.querySelector(`[data-index="${index}"]`);
        if (key) {
            key.classList.remove('active');
        }
        if (this.viewer3d && this.viewer3d.ready) {
            this.viewer3d.setKeyVisual(index, false);
        }

        // 记录MIDI音符结束
        const noteData = this.notes[index];
        this.recordNoteOff(noteData.midiNote, index);

        this._sendMidiExchange({
            type: 'note_off',
            note: noteData.midiNote,
            velocity: 0,
            channel: 0,
            timestamp: Date.now(),
        });

        // 实时映射：记录 live note off
        try {
            this._liveNoteOff(noteData.midiNote);
        } catch (err) {
            console.warn('liveNoteOff error', err);
        }
    }

    // 记录MIDI音符开始
    recordNoteOn(midiNote, index) {
        const now = Date.now();

        // ===== 移除自动开启录制的逻辑（删除以下代码块）=====
        // if (!this.isRecording) {
        //     this.isRecording = true;
        //     this.recordingStartTime = now;
        //     this.recordedNotes = [];
        //     this.activeNoteTimes.clear();

        //     // 显示录制状态
        //     const status = document.getElementById('recordingStatus');
        //     status.style.display = 'flex';
        //     document.getElementById('statusText').textContent = '录制中...';
        // }

        // ===== 新增：仅手动录制中时，才记录音符 =====
        if (!this.isRecording) return;

        const deltaTime = now - this.recordingStartTime;

        // 记录音符开始事件
        this.recordedNotes.push({
            deltaTime: deltaTime,
            type: 'noteOn',
            note: midiNote,
            velocity: 90,
            index: index  // 保存索引用于匹配Note Off
        });

        // 记录这个音符的开始时间和索引
        this.activeNoteTimes.set(midiNote, { startTime: deltaTime, index: index });

        this.lastNoteTime = now;
        this.resetRecordingTimeout();
    }

    // ===== 实时映射 (Music -> Fragment) =====
    _liveNoteOn(midiNote) {
        if (!this.liveMappingEnabled || this.isPlaying) return;
        const now = Date.now();
        if (!this.liveStartTime) this.liveStartTime = now;
        // 记录按下时间
        this.liveActiveMap.set(midiNote, now);
        // 防抖触发更新
        this._scheduleLiveUpdate();
    }

    _liveNoteOff(midiNote) {
        if (!this.liveMappingEnabled || this.isPlaying) return;
        const now = Date.now();
        const start = this.liveActiveMap.get(midiNote);
        let duration = 150;
        if (start) {
            const startRel = start - this.liveStartTime;
            duration = now - start;
            this.liveEvents.push({ start: startRel, duration: duration, note: midiNote });
            // 保持历史长度，避免内存增长
            if (this.liveEvents.length > 128) this.liveEvents.shift();
            this.liveActiveMap.delete(midiNote);
        } else {
            // 如果没有开始记录，仍添加短音符
            const startRel = (this.liveStartTime ? now - this.liveStartTime : 0);
            this.liveEvents.push({ start: startRel, duration: 150, note: midiNote });
            if (this.liveEvents.length > 128) this.liveEvents.shift();
        }
        // 实时更新五线谱
        if (this.staffRenderer) {
            this.staffRenderer.addNote(midiNote, duration);
        }
        this._scheduleLiveUpdate();
    }

    _scheduleLiveUpdate() {
        if (this.liveUpdateTimer) clearTimeout(this.liveUpdateTimer);
        // 200ms debounce to avoid频繁DOM更新
        this.liveUpdateTimer = setTimeout(() => {
            try { this.updateLiveFragment(); } catch (e) { console.error('updateLiveFragment error', e); }
        }, 200);
    }


    // ===== 新增：专门调用后端画 3D 图的函数 =====
    fetchAndRender3D(smiles) {
        if (!smiles || smiles === '—') return;

        fetch(this._getMidiExchangeBaseUrl().replace(/\/$/, '') + '/render_svg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ smiles })
        })
            .then(res => res.json())
            .then(data => {
                // 如果后端返回错误（例如不合法的化学式），直接清空 3D 视图
                if (data.error) {
                    const viewerContainer = document.getElementById('liveMol3D');
                    if (viewerContainer) viewerContainer.innerHTML = `<div style="padding:20px; color:#ff8a80;">分子结构不合法，无法生成 3D 模型：${data.error}</div>`;
                    return;
                }

                // 渲染 3D 模型
                if (data.mol_block_3d) {
                    const viewerContainer = document.getElementById('liveMol3D');
                    if (viewerContainer) {
                        viewerContainer.innerHTML = ''; // 先清空旧模型
                        let viewer = $3Dmol.createViewer(viewerContainer, { backgroundColor: '#0d0d0d' });
                        viewer.addModel(data.mol_block_3d, "sdf");
                        // 药学常用的精美球棍渲染风格（略放大便于辨认）
                        viewer.setStyle({}, { stick: { radius: 0.32, color: 'spectrum' }, sphere: { scale: 0.52, color: 'spectrum' } });
                        const applyZoom = () => {
                            viewer.zoomTo();
                            try {
                                if (typeof viewer.zoom === 'function') viewer.zoom(1.45);
                            } catch (e) { /* ignore */ }
                        };
                        applyZoom();
                        const fitViewer = () => {
                            try {
                                viewer.resize();
                                applyZoom();
                                viewer.render();
                            } catch (e) { /* ignore */ }
                        };
                        fitViewer();
                        requestAnimationFrame(fitViewer);
                        setTimeout(fitViewer, 80);
                        window._musicMolViewerRef = viewer;
                        if (!window._musicMolSpinRaf) {
                            const spin = () => {
                                window._musicMolSpinRaf = requestAnimationFrame(spin);
                                const v = window._musicMolViewerRef;
                                if (!v || typeof v.rotate !== 'function') return;
                                try {
                                    v.rotate(0.32, 'y');
                                    v.render();
                                } catch (e) { /* ignore */ }
                            };
                            window._musicMolSpinRaf = requestAnimationFrame(spin);
                        }
                    }
                }
            })
            .catch(err => console.log('等待后端连接或渲染失败...'));
    }

    updateLiveFragment() {
        // 1. 安全检查：如果关闭了实时生成，或者事件为空，直接返回
        if (!this.liveMappingEnabled || !this.liveEvents || this.liveEvents.length === 0) return;

        const events = this.liveEvents.slice(-64);

        // 2. 调用智能引擎解析
        // 确保你已经引入了 score_to_smiles.js
        if (!window.ReverseInterpreter) return;
        const smiles = window.ReverseInterpreter.parse(events);

        if (!smiles) return;

        // 3. 【核心修复】只更新现在页面上还存在的元素
        const elSmiles = document.getElementById('liveSmiles');
        if (elSmiles) {
            elSmiles.textContent = smiles;
        }

        // 4. 执行 3D 渲染
        this.fetchAndRender3D(smiles);
    }

    _buildSnapshotEventsForSmiles() {
        const snapshot = Array.isArray(this.liveEvents) ? this.liveEvents.slice(-96) : [];
        const now = Date.now();
        const base = this.liveStartTime || now;
        this.liveActiveMap.forEach((startTs, midiNote) => {
            snapshot.push({
                start: Math.max(0, startTs - base),
                duration: Math.max(120, now - startTs),
                note: midiNote
            });
        });
        return snapshot.sort((a, b) => a.start - b.start);
    }

    async handleGenerateMoleculeFromPerformance() {
        const events = this._buildSnapshotEventsForSmiles();
        if (!events.length) {
            this.showSmilesInfo('暂无可转换的演奏内容，请先弹奏后再生成分子', 'error');
            return;
        }
        this.showSmilesInfo('正在调用 Transformer/beam/QED 推理…', 'loading');

        const resultDisplay = document.getElementById('smilesResultDisplay');
        const genBtn = document.getElementById('pianoGenerateMoleculeBtn');
        if (resultDisplay) {
            resultDisplay.textContent = '⏳ 推理中，请稍候…';
            resultDisplay.style.color = '#e8c547';
        }
        if (genBtn) genBtn.disabled = true;

        try {
            const bpm = 100; // 默认 BPM，可根据需要调整
            const result = await window.musicToMolecule(events, bpm);
            if (resultDisplay) {
                if (!result.ok) {
                    resultDisplay.textContent = '❌ ' + (result.error || '推理失败');
                    resultDisplay.style.color = '#ff6b6b';
                } else {
                    resultDisplay.textContent = result.best_smiles;
                    resultDisplay.style.color = '#7ee787';
                    this.fetchAndRender3D(result.best_smiles);
                }
            }
        } catch (err) {
            console.error('musicToMolecule error', err);
            if (resultDisplay) {
                resultDisplay.textContent = '❌ 网络或推理错误';
                resultDisplay.style.color = '#ff6b6b';
            }
        } finally {
            if (genBtn) genBtn.disabled = false;
        }
    }

    // 记录MIDI音符结束
    recordNoteOff(midiNote, index) {
        if (!this.isRecording) return;

        const now = Date.now();
        const deltaTime = now - this.recordingStartTime;

        // 获取该音符的开始时间
        const noteInfo = this.activeNoteTimes.get(midiNote);
        if (noteInfo) {
            const duration = deltaTime - noteInfo.startTime;

            // 如果音符持续时间太短(小于50ms),延长到至少150ms
            const minDuration = 150;
            const actualOffTime = duration < minDuration ?
                noteInfo.startTime + minDuration : deltaTime;

            // 记录音符结束事件
            this.recordedNotes.push({
                deltaTime: actualOffTime,
                type: 'noteOff',
                note: midiNote,
                velocity: 0,
                index: index
            });

            this.activeNoteTimes.delete(midiNote);
        } else {
            // 如果找不到开始时间,使用当前时间
            this.recordedNotes.push({
                deltaTime: deltaTime,
                type: 'noteOff',
                note: midiNote,
                velocity: 0,
                index: index
            });
        }

        this.lastNoteTime = now;
        this.resetRecordingTimeout();
    }

    // 重置录制超时计时器
    resetRecordingTimeout() {
        if (this.recordingTimeout) {
            clearTimeout(this.recordingTimeout);
            this.recordingTimeout = null;//新增
        }

        // // 5秒无活动后自动保存MIDI
        // this.recordingTimeout = setTimeout(() => {
        //     this.finishRecording();
        // }, 5000);
    }

    // 完成录制并保存MIDI
    async finishRecording() {
        if (this.recordedNotes.length === 0) {
            this.isRecording = false;
            const status = document.getElementById('recordingStatus');
            if (status) status.style.display = 'none';
            return;
        }

        console.log('录制完成! 保存MIDI文件到本地...');
        console.log('录制的音符数:', this.recordedNotes.length);

        const status = document.getElementById('recordingStatus');
        const statusText = document.getElementById('statusText');
        if (statusText) statusText.textContent = '正在保存...';

        // 生成MIDI文件
        const midiData = this.generateMidiFile();

        // 保存到本地result目录
        await this.saveMidiToLocal(midiData);

        // // 2秒后隐藏状态
        // setTimeout(() => {
        //     status.style.display = 'none';
        // }, 2000);

        if (status) status.style.display = 'none';

        // 重置录制状态
        this.isRecording = false;
        this.recordedNotes = [];
        this.activeNoteTimes.clear();
    }

    // 生成MIDI文件
    generateMidiFile() {
        // 创建完整的事件列表
        const allEvents = [];

        this.recordedNotes.forEach(event => {
            allEvents.push({
                time: event.deltaTime,
                type: event.type,
                note: event.note,
                velocity: event.velocity
            });
        });

        // 按时间排序所有事件
        allEvents.sort((a, b) => {
            if (a.time !== b.time) return a.time - b.time;
            // 同一时间,Note Off优先于Note On
            if (a.type === 'noteOff' && b.type === 'noteOn') return -1;
            if (a.type === 'noteOn' && b.type === 'noteOff') return 1;
            return 0;
        });

        // 转换为MIDI事件(计算相对delta time)
        const midiEvents = [];
        let lastTime = 0;

        allEvents.forEach((event, index) => {
            const deltaTime = event.time - lastTime;
            lastTime = event.time;

            // 转换毫秒为MIDI ticks
            // 480 ticks per beat, 120 BPM = 500ms per beat
            // 所以 1ms = 0.96 ticks
            const ticks = Math.max(0, Math.round(deltaTime * 0.96));

            midiEvents.push({
                deltaTime: ticks,
                type: event.type === 'noteOn' ? 0x90 : 0x80,
                note: event.note,
                velocity: event.type === 'noteOn' ? event.velocity : 0
            });
        });

        console.log('MIDI事件数:', midiEvents.length);
        console.log('总时长(ticks):', midiEvents.reduce((sum, e) => sum + e.deltaTime, 0));

        // 创建MIDI文件
        return this.createMidiFile(midiEvents);
    }

    // 创建MIDI文件 (标准格式)
    createMidiFile(events) {
        // MIDI文件头 (MThd)
        const header = new Uint8Array([
            0x4D, 0x54, 0x68, 0x64, // "MThd"
            0x00, 0x00, 0x00, 0x06, // 头部长度 = 6
            0x00, 0x00,             // 格式0 (单音轨)
            0x00, 0x01,             // 1个音轨
            0x01, 0xE0              // 480 ticks per quarter note
        ]);

        // 构建音轨数据
        const trackEvents = [];

        // 设置速度 (120 BPM)
        trackEvents.push(
            0x00,                   // Delta time
            0xFF, 0x51, 0x03,       // Set Tempo meta event
            0x07, 0xA1, 0x20        // 500000 microseconds per quarter note (120 BPM)
        );

        // 设置乐器为钢琴
        trackEvents.push(
            0x00,                   // Delta time
            0xC0,                   // Program change on channel 0
            0x00                    // Acoustic Grand Piano
        );

        // 添加所有音符事件
        events.forEach(event => {
            // Delta time (variable length)
            const deltaBytes = this.encodeVariableLength(event.deltaTime);
            trackEvents.push(...deltaBytes);

            // MIDI事件
            trackEvents.push(event.type, event.note, event.velocity);
        });

        // 在最后一个事件后添加一个小延迟,然后结束音轨
        trackEvents.push(
            0x60,                   // 96 ticks延迟 (约100ms)
            0xFF, 0x2F, 0x00        // End of Track
        );

        // 音轨头部 (MTrk)
        const trackLength = trackEvents.length;
        const trackHeader = new Uint8Array([
            0x4D, 0x54, 0x72, 0x6B,                     // "MTrk"
            (trackLength >> 24) & 0xFF,
            (trackLength >> 16) & 0xFF,
            (trackLength >> 8) & 0xFF,
            trackLength & 0xFF
        ]);

        // 合并所有数据
        const midiFile = new Uint8Array(header.length + trackHeader.length + trackEvents.length);
        midiFile.set(header, 0);
        midiFile.set(trackHeader, header.length);
        midiFile.set(trackEvents, header.length + trackHeader.length);

        console.log('MIDI文件总大小:', midiFile.length, 'bytes');

        return midiFile;
    }

    // 编码可变长度值 (MIDI标准)
    encodeVariableLength(value) {
        const bytes = [];
        bytes.push(value & 0x7F);

        value >>= 7;
        while (value > 0) {
            bytes.unshift((value & 0x7F) | 0x80);
            value >>= 7;
        }

        return bytes;
    }

    // 保存MIDI到本地result目录
    async saveMidiToLocal(midiData) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `pianomol_${timestamp}.mid`;

        // 创建Blob和下载链接
        const blob = new Blob([midiData], { type: 'audio/midi' });
        const url = URL.createObjectURL(blob);

        // 自动下载到浏览器的下载目录
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // 释放URL对象
        setTimeout(() => URL.revokeObjectURL(url), 100);

        console.log(`✅ MIDI文件已保存: ${filename}`);

        const st = document.getElementById('statusText');
        if (st) st.textContent = '已保存!';
    }

    // 更新音符显示
    updateNoteDisplay(note) {
        const display = document.getElementById('noteDisplay');
        if (!display) return;
        display.textContent = note;
        display.classList.remove('note-active');
        void display.offsetWidth;
        display.classList.add('note-active');
    }

    setupEventListeners() {
        if (this.isPrimaryPiano) {
            document.addEventListener('keydown', (e) => this.handleKeyDown(e));
            document.addEventListener('keyup', (e) => this.handleKeyUp(e));

            const showHintsBtn = document.getElementById('showHintsBtn');
            if (showHintsBtn) {
                showHintsBtn.addEventListener('click', () => this.toggleHints());
            }

            const recordBtn = document.getElementById('recordBtn');
            if (recordBtn) {
                recordBtn.addEventListener('click', () => this.toggleRecording());
            }

            const playBtn = document.getElementById('playMidiBtn');
            if (playBtn) {
                playBtn.addEventListener('click', () => this.handleSmilesPlay());
            }

            const stopBtn = document.getElementById('stopMidiBtn');
            if (stopBtn) {
                stopBtn.addEventListener('click', () => this.stopAutoPlay());
            }

            const genBtn = document.getElementById('pianoGenerateMoleculeBtn');
            if (genBtn) {
                genBtn.addEventListener('click', () => this.handleGenerateMoleculeFromPerformance());
            }

            const smilesInput = document.getElementById('smilesInput');
            if (smilesInput) {
                smilesInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.handleSmilesPlay();
                });
            }

            const liveCb = document.getElementById('enableLiveMap');
            if (liveCb) {
                liveCb.addEventListener('change', (e) => {
                    this.liveMappingEnabled = !!e.target.checked;
                    if (!this.liveMappingEnabled) {
                        const elS = document.getElementById('liveSmiles'); if (elS) elS.textContent = '—';
                    }
                });
            }

            window.addEventListener('keydown', (e) => {
                if (e.key === ' ') e.preventDefault();
            });

            document.querySelectorAll('input[name="pianoPlayMode"]').forEach((r) => {
                r.addEventListener('change', () => {
                    if (r.checked) this.setPlayMode(r.value);
                });
            });
        }
    }

    setPlayMode(mode) {
        const prev = this.playMode;
        this.playMode = mode === 'api' ? 'api' : 'mouse';
        if (this.viewer3d && this.viewer3d.ready) {
            this.viewer3d._dragging = false;
            this.viewer3d.activeIndex = null;
            if (prev === 'api' && this.playMode !== 'api' && typeof this.viewer3d.resetApiKeyFx === 'function') {
                this.viewer3d.resetApiKeyFx();
            }
        }
        document.querySelectorAll('input[name="pianoPlayMode"]').forEach((el) => {
            el.checked = el.value === this.playMode;
        });
    }

    getPlayMode() {
        return this.playMode;
    }

    midiToKeyIndex(midiNote) {
        return this.notes.findIndex((n) => n.midiNote === midiNote);
    }

    /** 接口模式：按下 MIDI 音高（0–127），音长由后续 noteOff 或延音决定 */
    apiNoteOn(midiNote) {
        this.initAudio();
        const idx = this.midiToKeyIndex(midiNote);
        if (idx < 0) return false;
        this.startNote(idx, null);
        return true;
    }

    apiNoteOff(midiNote) {
        const idx = this.midiToKeyIndex(midiNote);
        if (idx < 0) return false;
        this.stopNote(idx);
        return true;
    }

    /**
     * 接口模式：按时间轴播放 MIDI 事件列表（与 SMILES 自动演奏相同格式）
     * @param {{ note: number, time: number, duration?: number }[]} events
     */
    apiPlayMidiEvents(events) {
        if (!Array.isArray(events)) return false;
        this.autoPlayMidi(events);
        return true;
    }

    // ===== 新增：录制切换方法（放在setupEventListeners后）=====
    toggleRecording() {
        if (!this.isRecording) {
            // 开始录制
            this.isRecording = true;
            this.recordingStartTime = Date.now();
            this.recordedNotes = [];
            this.activeNoteTimes.clear();

            const recordBtn = document.getElementById('recordBtn');
            if (recordBtn) {
                recordBtn.innerHTML = '<span class="btn-icon">⏹️</span> 停止录制';
                recordBtn.classList.add('active');
            }
            const status = document.getElementById('recordingStatus');
            if (status) status.style.display = 'flex';
            const statusText = document.getElementById('statusText');
            if (statusText) statusText.textContent = '录制中...';

            console.log('✅ 开始手动录制MIDI');
        } else {
            // 停止录制并生成MIDI
            this.isRecording = false;

            const recordBtn = document.getElementById('recordBtn');
            if (recordBtn) {
                recordBtn.innerHTML = '<span class="btn-icon">🎙️</span> 开始录制';
                recordBtn.classList.remove('active');
            }

            // 触发录制完成（复用原有生成MIDI的逻辑）
            this.finishRecording();

            console.log('🛑 停止手动录制MIDI');
        }
    }

    handleKeyDown(e) {
        if (!e || !e.key) return; // ✨ 新增：拦截非标准键盘事件
        if (this.playMode === 'api') return;
        const key = e.key.toLowerCase();

        try {
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
                if (this.keyboardMap[key] || key === ' ') return;
            }
        } catch (err) { }

        // 延音踏板 (按空格)
        if (key === ' ') {
            e.preventDefault();
            if (!this.sustainEnabled) {
                this.sustainEnabled = true;
                const sustainBtn = document.getElementById('sustainBtn');
                if (sustainBtn) sustainBtn.classList.add('active');
                this._sendMidiExchange({
                    type: 'control_change',
                    cc: 64,
                    value: 127,
                    channel: 0,
                    timestamp: Date.now(),
                });
            }
            return;
        }

        // 播放音符
        if (this.keyboardMap[key]) {
            e.preventDefault();
            const noteName = this.keyboardMap[key];
            const index = this.notes.findIndex(n => n.note + n.octave === noteName);
            if (index !== -1 && !this.activeNotes.has(index)) {
                this.startNote(index);
            }
        }
    }

    handleKeyUp(e) {
        if (!e || !e.key) return; // ✨ 新增：拦截非标准键盘事件
        if (this.playMode === 'api') return;
        const key = e.key.toLowerCase();

        try {
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
                if (this.keyboardMap[key] || key === ' ') return;
            }
        } catch (err) { }

        // 释放延音踏板
        if (key === ' ') {
            e.preventDefault();
            this._sendMidiExchange({
                type: 'control_change',
                cc: 64,
                value: 0,
                channel: 0,
                timestamp: Date.now(),
            });
            this.sustainEnabled = false;
            const sustainBtn = document.getElementById('sustainBtn');
            if (sustainBtn) sustainBtn.classList.remove('active');

            this.sustainedNotes.forEach(index => this.stopNote(index));
            this.sustainedNotes.clear();
            return;
        }

        // 释放音符
        if (this.keyboardMap[key]) {
            e.preventDefault();
            const noteName = this.keyboardMap[key];
            const index = this.notes.findIndex(n => n.note + n.octave === noteName);
            if (index !== -1) {
                this.stopNote(index);
            }
        }
    }

    // 切换键位提示（仅 DOM 键盘模式有效；当前为 3D 钢琴时仅切换按钮态）
    toggleHints() {
        this.showHints = !this.showHints;
        const kb = document.getElementById(this.keyboardElId);
        if (kb) kb.classList.toggle('show-hints', this.showHints);
        const btn = document.getElementById('showHintsBtn');
        if (btn) btn.classList.toggle('active', this.showHints);
    }

    // 切换延音
    toggleSustain() {
        this.sustainEnabled = !this.sustainEnabled;
        document.getElementById('sustainBtn').classList.toggle('active', this.sustainEnabled);

        this._sendMidiExchange({
            type: 'control_change',
            cc: 64,
            value: this.sustainEnabled ? 127 : 0,
            channel: 0,
            timestamp: Date.now(),
        });

        if (!this.sustainEnabled) {
            this.sustainedNotes.forEach(index => {
                this.stopNote(index);
            });
            this.sustainedNotes.clear();
        }
    }

    // 切换音量滑块显示
    toggleVolumeSlider() {
        const sliderContainer = document.getElementById('volumeSliderContainer');
        const isVisible = sliderContainer.style.display !== 'none';
        sliderContainer.style.display = isVisible ? 'none' : 'block';
    }

    // 设置音量
    setVolume(value) {
        this.masterVolume = value / 100;
        document.getElementById('volumeValue').textContent = value + '%';
    }

    // ===== SMILES 自动演奏功能 =====

    // 处理SMILES演奏 - 最稳健修复版
    handleSmilesPlay() {
        // 1. 获取输入框，增加安全报错
        const smilesInput = document.getElementById('smilesInput');
        if (!smilesInput) {
            console.error("未找到 id='smilesInput' 的输入框，请检查 HTML");
            return;
        }

        const smiles = smilesInput.value.trim();
        if (!smiles) {
            this.showSmilesInfo('请输入SMILES字符串', 'error');
            return;
        }

        // 2. 安全更新面板文字 (即使某些元素被注释掉也不会崩溃)
        const elSmiles = document.getElementById('liveSmiles');
        if (elSmiles) elSmiles.textContent = smiles;

        const elStaff = document.getElementById('liveStaff');
        if (elStaff) elStaff.textContent = '（自动演奏模式：已锁定对应构象）';

        const elMol = document.getElementById('liveMol');
        if (elMol) elMol.textContent = '（依据上方的 SMILES 输入生成）';

        // 3. 清理之前的弹奏记录并渲染 3D
        this.liveEvents = [];
        this.fetchAndRender3D(smiles);

        this.showSmilesInfo('正在转换SMILES为MIDI...', 'loading');

        try {
            // 4. 核心转换逻辑
            const midiEvents = this.smilesToMidi(smiles);

            if (!midiEvents || midiEvents.length === 0) {
                this.showSmilesInfo('SMILES转换失败，请检查格式', 'error');
                return;
            }

            this.showSmilesInfo(`准备演奏 ${midiEvents.length} 个音符...`, 'success');

            // 5. 启动自动演奏
            setTimeout(() => {
                this.autoPlayMidi(midiEvents);
            }, 500);

        } catch (error) {
            console.error('SMILES转换错误:', error);
            this.showSmilesInfo('转换失败: ' + error.message, 'error');
        }
    }

    // SMILES转MIDI (调用新引入的 smile_to_score.js 核心逻辑)
    smilesToMidi(smiles) {
        if (typeof window.generateScoreFromSmiles === 'function') {
            // 返回处理好的事件数组，BPM 默认为 100
            return window.generateScoreFromSmiles(smiles, 100);
        } else {
            console.error('未找到解析器！请确保 smile_to_score.js 已经正确引入。');
            return [];
        }
    }

    // 自动演奏MIDI (一次性发送给底层)
    autoPlayMidi(midiEvents) {
        if (this.isPlaying) this.stopAutoPlay();

        const runSchedule = () => {
            this.isPlaying = true;
            this.playbackTimeouts = [];
            this.initAudio();

            document.getElementById('playMidiBtn').style.display = 'none';
            document.getElementById('stopMidiBtn').style.display = 'flex';
            this.showSmilesInfo('正在演奏...', 'playing');

            midiEvents.forEach(event => {
                const index = this.notes.findIndex(n => n.midiNote === event.note);
                if (index !== -1) {
                    this.scheduleNote(index, event.time, event.duration || 500);
                }
            });

            const totalDuration = midiEvents.length > 0
                ? Math.max(...midiEvents.map(e => e.time + (e.duration || 500)))
                : 0;

            const endTimeout = setTimeout(() => {
                this.stopAutoPlay();
                this.showSmilesInfo('演奏完成!', 'success');
                setTimeout(() => {
                    document.getElementById('smilesInfo').style.display = 'none';
                }, 3000);
            }, totalDuration + 500);

            this.playbackTimeouts.push(endTimeout);
        };

        const p = this.unlockAudio();
        (p && typeof p.then === 'function' ? p : Promise.resolve())
            .then(runSchedule)
            .catch(runSchedule);
    }

    // 全新调度器：音画分离
    scheduleNote(index, delayMs, durationMs) {
        const noteData = this.notes[index];
        if (!noteData) return;

        this.initAudio();
        const ctx = this.audioContext;

        // 1. 安排完美无瑕的底层音频 (不受任何卡顿影响)
        const audioStartTime = ctx.currentTime + (delayMs / 1000);
        const durationSec = durationMs / 1000;
        this.playNote(noteData.freq, durationSec, audioStartTime);

        // 2. 安排视觉效果 (UI 允许有微小的渲染延迟，这是可以接受的)
        const visualStart = setTimeout(() => {
            const key = document.querySelector(`[data-index="${index}"]`);
            if (key) {
                key.classList.add('active');
                this.createNoteParticle(noteData.note + noteData.octave, key);
            } else {
                if (this.viewer3d && this.viewer3d.ready) {
                    this.viewer3d.setKeyVisual(index, true);
                }
                this.createNoteParticle(noteData.note + noteData.octave, null, {
                    keyIndex: index,
                    totalKeys: this.notes.length,
                    fromApi: this.playMode === 'api',
                });
            }
            this.updateNoteDisplay(noteData.note + noteData.octave);
        }, delayMs);
        this.playbackTimeouts.push(visualStart);

        // 3. 安排视觉效果的结束
        const visualEnd = setTimeout(() => {
            const key = document.querySelector(`[data-index="${index}"]`);
            if (key) {
                key.classList.remove('active');
            }
            if (this.viewer3d && this.viewer3d.ready) {
                this.viewer3d.setKeyVisual(index, false);
            }
        }, delayMs + durationMs);
        this.playbackTimeouts.push(visualEnd);
    }

    // 停止自动演奏 (硬核刹车)
    stopAutoPlay() {
        this.isPlaying = false;

        // 1. 停止所有的网页 UI 动画
        this.playbackTimeouts.forEach(timeout => clearTimeout(timeout));
        this.playbackTimeouts = [];

        if (this.viewer3d && this.viewer3d.ready && typeof this.viewer3d.resetApiKeyFx === 'function') {
            this.viewer3d.resetApiKeyFx();
        }

        // 2. 清理所有琴键的按下状态
        document.querySelectorAll('.key.active').forEach(key => {
            key.classList.remove('active');
        });
        if (this.viewer3d && this.viewer3d.ready) {
            this.notes.forEach((_, i) => this.viewer3d.setKeyVisual(i, false));
        }

        // 3. 暂停音频时钟（不 close）：避免每次轮询 stop 后再 new 出仍处于 suspended 的上下文导致无声
        if (this.audioContext) {
            try {
                const st = this.audioContext.state;
                if (st === 'running' || st === 'suspended') {
                    this.audioContext.suspend();
                }
            } catch (e) {
                /* ignore */
            }
        }

        // 恢复按钮状态
        document.getElementById('playMidiBtn').style.display = 'flex';
        document.getElementById('stopMidiBtn').style.display = 'none';

        this.showSmilesInfo('演奏已停止', 'info');
    }

    // 显示SMILES信息 (防崩溃安全版)
    showSmilesInfo(message, type = 'info') {
        const infoPanel = document.getElementById('smilesInfo');
        const infoText = document.getElementById('infoText');

        // ✨ 核心修复：如果网页上已经删掉了提示框，就转为在控制台输出，绝不报错卡死！
        if (!infoPanel || !infoText) {
            console.log(`[状态: ${type}] ${message}`);
            return;
        }

        const infoIcon = infoPanel.querySelector('.info-icon');

        infoText.textContent = message;
        infoPanel.style.display = 'flex';

        // 根据类型设置图标和样式
        const iconMap = {
            'info': 'ℹ️',
            'success': '✅',
            'error': '❌',
            'loading': '⏳',
            'playing': '🎵'
        };

        const colorMap = {
            'info': 'rgba(59, 130, 246, 0.15)',
            'success': 'rgba(34, 197, 94, 0.15)',
            'error': 'rgba(239, 68, 68, 0.15)',
            'loading': 'rgba(251, 191, 36, 0.15)',
            'playing': 'rgba(168, 85, 247, 0.15)'
        };

        if (infoIcon) infoIcon.textContent = iconMap[type] || 'ℹ️';
        infoPanel.style.background = colorMap[type] || colorMap.info;
    }
}

// 初始化：单块宽域钢琴（原扩展键盘区）
document.addEventListener('DOMContentLoaded', () => {
    const modeEl = document.querySelector('input[name="pianoPlayMode"]:checked');
    const initialPlayMode = modeEl && modeEl.value === 'api' ? 'api' : 'mouse';

    window.piano = new Piano({
        isPrimaryPiano: true,
        canvasId: 'piano3dCanvasExtended',
        keyboardElId: 'keyboardExtended',
        notesRange: 'extended',
        keyStandard: 'gb',
        playMode: initialPlayMode,
        showDimOverlay: true,
        dimOuterSelector: '#pianoExtendedOuter',
        dimIdPrefix: 'ext',
    });

    /**
     * 外部接口（接口演奏模式）：与 window.piano 同步
     * - setPlayMode('mouse'|'api')
     * - noteOn(midi) / noteOff(midi)
     * - playMidiEvents([{ note, time, duration? }, ...])  // time/duration 单位 ms
     * - stopPlayback() 停止自动序列并清理音频
     */
    window.MusicMolPiano = {
        setPlayMode(mode) {
            window.piano.setPlayMode(mode);
        },
        getPlayMode() {
            return window.piano.getPlayMode();
        },
        noteOn(midiNote) {
            return window.piano.apiNoteOn(midiNote);
        },
        noteOff(midiNote) {
            return window.piano.apiNoteOff(midiNote);
        },
        playMidiEvents(events) {
            return window.piano.apiPlayMidiEvents(events);
        },
        stopPlayback() {
            window.piano.stopAutoPlay();
        },
        /** 在用户点击「启用轮询」「请求并演奏」等手势里调用，避免轮询回调里无法 resume */
        unlockAudio() {
            return window.piano.unlockAudio();
        },
    };

    console.log('🎹 PianoMol initialized successfully by MusicMol Team!');
    console.log('钢琴键数:', window.piano.notes.length);
});
