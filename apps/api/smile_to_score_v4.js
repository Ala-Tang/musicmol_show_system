// smile_to_score_v4.5.js
// 基于 MusicMol 进阶规则：支持官能团自动减薄、0.2拍延音交叠、取消苯环切分、左手自动伴奏织体

(function () {
    // 官能团定义：模拟 RDKit 的 SMARTS 匹配
    const FUNCTIONAL_GROUPS = [
        { smarts: 'C(=O)OC(=O)', prio: 1, name: 'FM7', notes: ['F4', 'A4', 'C5', 'E5'] },
        { smarts: 'C(=O)O', prio: 2, name: 'Dm7', notes: ['D4', 'F4', 'A4', 'C5'] },
        { smarts: 'C(=O)Cl', prio: 3, name: 'Gadd9', notes: ['G4', 'B4', 'D5', 'A5'] },
        { smarts: 'C(=O)Br', prio: 3, name: 'Gsus4', notes: ['G4', 'C5', 'D5'] },
        { smarts: 'C(=O)I', prio: 3, name: 'Gsus2', notes: ['G4', 'A4', 'D5'] },
        { smarts: 'C(=O)N', prio: 4, name: 'Asus2', notes: ['A4', 'B4', 'E5'] },
        { smarts: 'C(=O)O', prio: 5, name: 'Em', notes: ['E4', 'G4', 'B4'] },
        { smarts: 'C=O', prio: 6, name: 'Em7', notes: ['E4', 'G4', 'B4', 'D5'] },
        { smarts: 'O', prio: 7, name: 'Dm', notes: ['D4', 'F4', 'A4'] },
        { smarts: 'OO', prio: 8, name: 'G7', notes: ['G4', 'B4', 'D5', 'F5'] },
        { smarts: 'O', prio: 9, name: 'F', notes: ['F4', 'A4', 'C5'] },
        { smarts: '[CH3]', prio: 10, name: 'C', notes: ['C4', 'E4', 'G4'] },
        { smarts: '[CH2][CH3]', prio: 11, name: 'CM7', notes: ['C4', 'E4', 'G4', 'B4'] },
        { smarts: 'c1ccccc1', prio: 12, name: 'G', notes: ['G4', 'B4', 'D5'] },
        { smarts: '[NH2]', prio: 13, name: 'Am', notes: ['A4', 'C5', 'E5'] },
        { smarts: '[NH]', prio: 14, name: 'Am7', notes: ['A4', 'C5', 'E5', 'G5'] },
        { smarts: 'C#N', prio: 15, name: 'Asus4', notes: ['A4', 'D5', 'E5'] },
        { smarts: 'N(=O)=O', prio: 16, name: 'Csus4', notes: ['C4', 'F4', 'G4'] },
        { smarts: 'N=O', prio: 17, name: 'Csus2', notes: ['C4', 'D4', 'G4'] }
    ];

    const ATOM_PITCH_MAP = {
        'N': 'F5', 'O': 'A5', 'F': 'B5', 'Cl': 'G5', 'Br': 'E5',
        'I': 'E5', 'At': 'E5', 'S': 'D5', 'Se': 'D5', 'Te': 'D5',
        'P': 'C5', 'As': 'C5', 'B': 'C5', 'Si': 'C5', 'other': 'E6'
    };

    const HYBRID_PITCH = {
        'SP': 'C3',
        'SP2': 'C4',
        'SP3': 'C5'
    };

    // 工具函数：音名转 MIDI 数字
    function noteNameToMidi(n) {
        const m = n.match(/^([A-G])(#?)(\d+)$/);
        if (!m) return 60;
        const noteBase = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
        let semis = noteBase[m[1]] + (m[2] ? 1 : 0);
        return (parseInt(m[3], 10) + 1) * 12 + semis;
    }

    // 工具函数：MIDI 数字转音名
    function midiToNoteName(midi) {
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        const note = noteNames[midi % 12];
        return note + octave;
    }

    // 1. 模拟 RDKit 的特征解析器
    function parseRawSmiles(s) {
        let atoms_data = [];
        let atom_indices = [];
        let atom_depths = [];
        let atom_parent_main = [];
        let stack = [];
        let depth = 0;
        let current_main = null;
        let atom_counter = 0;

        let pending_double = false;
        let pending_triple = false;
        let last_atom_idx = -1;

        let i = 0;
        let n = s.length;

        while (i < n) {
            let ch = s[i];

            if (ch === '(') {
                depth++;
                if (current_main !== null) stack.push(current_main);
                i++;
            } else if (ch === ')') {
                depth--;
                if (stack.length > 0) stack.pop();
                i++;
            } else if (ch === '=') {
                pending_double = true;
                if (last_atom_idx !== -1) atoms_data[last_atom_idx].is_double = true;
                i++;
            } else if (ch === '#') {
                pending_triple = true;
                if (last_atom_idx !== -1) atoms_data[last_atom_idx].is_triple = true;
                i++;
            } else if (/\d/.test(ch)) {
                if (last_atom_idx !== -1) atoms_data[last_atom_idx].in_ring = true;
                i++;
            } else if (['-', '/', '\\'].includes(ch)) {
                i++;
            } else if (ch === '[') {
                let end = s.indexOf(']', i);
                let content = s.substring(i, end + 1);
                let match = content.match(/[A-Z][a-z]?|[a-z]/);
                let symbol_raw = match ? match[0] : "";
                addAtom(symbol_raw, i, end + 1);
                i = end + 1;
            } else {
                let match = s.slice(i).match(/^([A-Z][a-z]?|[a-z])/);
                if (match) {
                    addAtom(match[0], i, i + match[0].length);
                    i += match[0].length;
                } else {
                    i++;
                }
            }
        }

        function addAtom(symbol_raw, startIdx, endIdx) {
            let is_dbl = pending_double;
            let is_tpl = pending_triple;
            pending_double = false;
            pending_triple = false;

            let parent = (depth === 0) ? null : (stack.length > 0 ? stack[stack.length - 1] : null);
            if (depth === 0) current_main = atom_counter;

            let is_aromatic = /^[a-z]/.test(symbol_raw);

            atoms_data.push({
                idx: atom_counter,
                symbol: symbol_raw.toUpperCase(),
                is_aromatic: is_aromatic,
                in_ring: false,
                is_double: is_dbl,
                is_triple: is_tpl,
                hybrid: 'SP3',
                fg: null,
                fg_inst_id: null,
                strStart: startIdx,
                strEnd: endIdx
            });

            atom_indices.push(atom_counter);
            atom_depths.push(depth);
            atom_parent_main.push(parent);

            last_atom_idx = atom_counter;
            atom_counter++;
        }

        atoms_data.forEach(a => {
            if (a.is_triple) a.hybrid = 'SP';
            else if (a.is_double || a.is_aromatic) a.hybrid = 'SP2';
        });

        // 官能团匹配与实例 ID 分配
        let fg_inst_counter = 0;
        let fg_patterns = FUNCTIONAL_GROUPS.map(fg => {
            let escaped = fg.smarts.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
            return { regex: new RegExp(escaped, 'g'), fg: fg };
        });

        fg_patterns.forEach(patt => {
            let match;
            while ((match = patt.regex.exec(s)) !== null) {
                fg_inst_counter++;
                let matchStart = match.index;
                let matchEnd = match.index + match[0].length;

                atoms_data.forEach(a => {
                    if (a.strStart >= matchStart && a.strEnd <= matchEnd) {
                        if (!a.fg || a.fg.prio > patt.fg.prio) {
                            a.fg = patt.fg;
                            a.fg_inst_id = fg_inst_counter;
                        }
                    }
                });
            }
        });

        return { atom_indices, atom_depths, atom_parent_main, atoms_data };
    }

    // 2. 核心：生成音符事件序列
    function generateEvents(smiles) {
        let parsed = parseRawSmiles(smiles);
        let allEvents = [];
        let current_offset = 0.0;
        let played_fgs = new Set(); // 记录已弹奏完整和弦的官能团实例

        let main_chain_atoms = parsed.atom_indices.filter((idx, i) => parsed.atom_depths[i] === 0);
        let main_chain_branches = main_chain_atoms.map(main_idx => {
            return parsed.atom_indices.filter((idx, i) => parsed.atom_parent_main[i] === main_idx);
        });

        function getPitchForAtom(atom, isBranch) {
            if (atom.fg) {
                let inst_id = atom.fg_inst_id;
                let notes_str = atom.fg.notes;

                // 减薄逻辑：第一拍出全和弦，后续变为极简双音
                if (!played_fgs.has(inst_id)) {
                    played_fgs.add(inst_id);
                } else {
                    notes_str = [notes_str[0], notes_str[notes_str.length - 1]];
                }

                if (isBranch) notes_str = notes_str.map(n => n.replace('4', '3'));
                return { isChord: true, pitches: notes_str };
            } else {
                let pitch = (atom.symbol === 'C') ? (HYBRID_PITCH[atom.hybrid] || 'C5') : (ATOM_PITCH_MAP[atom.symbol] || ATOM_PITCH_MAP['other']);
                if (isBranch) pitch = pitch.replace(/(\d+)/, match => String(parseInt(match) - 1));
                return { isChord: false, pitch: pitch };
            }
        }

        function createNotesFromAtom(atom, isBranch, velocity) {
            let notes_list = [];
            let pObj = getPitchForAtom(atom, isBranch);
            let ext = 0.2; // 全局 0.2 拍延音交叠

            function addNote(relTime, base_length) {
                let total_length = base_length + ext;
                if (pObj.isChord) {
                    pObj.pitches.forEach(p => notes_list.push({ pitch: p, startBeatOffset: relTime, durationBeats: total_length, velocity }));
                } else {
                    notes_list.push({ pitch: pObj.pitch, startBeatOffset: relTime, durationBeats: total_length, velocity });
                }
            }

            if (atom.is_triple) {
                // 三连音，仅延长第一个音
                addNote(0.0, 1 / 3);

                let lenRest = 1 / 3;
                if (pObj.isChord) {
                    pObj.pitches.forEach(p => {
                        notes_list.push({ pitch: p, startBeatOffset: 1 / 3, durationBeats: lenRest, velocity });
                        notes_list.push({ pitch: p, startBeatOffset: 2 / 3, durationBeats: lenRest, velocity });
                    });
                } else {
                    notes_list.push({ pitch: pObj.pitch, startBeatOffset: 1 / 3, durationBeats: lenRest, velocity });
                    notes_list.push({ pitch: pObj.pitch, startBeatOffset: 2 / 3, durationBeats: lenRest, velocity });
                }
            } else if (atom.is_double) {
                // 双键，仅延长第一个音
                addNote(0.0, 0.5);

                let lenRest = 0.5;
                if (pObj.isChord) {
                    pObj.pitches.forEach(p => notes_list.push({ pitch: p, startBeatOffset: 0.5, durationBeats: lenRest, velocity }));
                } else {
                    notes_list.push({ pitch: pObj.pitch, startBeatOffset: 0.5, durationBeats: lenRest, velocity });
                }
            } else if (atom.is_aromatic) {
                // ⚠️ 修改点1：取消苯环切分，恢复平稳 1.0 时长（带 0.2 延音）
                addNote(0.0, 1.0);
            } else if (atom.in_ring) {
                // 脂肪环（如环丙烷）保留半拍断奏的跳跃感，但含延音
                addNote(0.0, 0.5);
            } else {
                // 普通单音
                addNote(0.0, 1.0);
            }
            return notes_list;
        }

        const VOL_BACKBONE = 110;
        const VOL_BRANCH = 77;
        const VOL_PAD = 60; // 左手伴奏力度轻柔

        // 主循环组装时间线
        main_chain_atoms.forEach((atom_idx, i) => {
            let atom = parsed.atoms_data[atom_idx];

            // ⚠️ 修改点2：生成左手自动伴奏（每 2 拍生成一次低音和弦铺底）
            if (current_offset % 2.0 === 0) {
                let pObj = getPitchForAtom(atom, false);
                let rootPitchStr = pObj.isChord ? pObj.pitches[0] : pObj.pitch;

                let rootMidi = noteNameToMidi(rootPitchStr) - 24; // 降两个八度到低音区

                // 防止极端情况音高越界
                if (rootMidi >= 21 && rootMidi <= 108) {
                    // 构建空心五度和弦 (根音, 纯五度, 八度)
                    allEvents.push({ pitch: midiToNoteName(rootMidi), startBeat: current_offset, durationBeats: 2.0, velocity: VOL_PAD });
                    allEvents.push({ pitch: midiToNoteName(rootMidi + 7), startBeat: current_offset, durationBeats: 2.0, velocity: VOL_PAD });
                    allEvents.push({ pitch: midiToNoteName(rootMidi + 12), startBeat: current_offset, durationBeats: 2.0, velocity: VOL_PAD });
                }
            }

            // 主旋律生成
            let notes = createNotesFromAtom(atom, false, VOL_BACKBONE);
            notes.forEach(n => {
                allEvents.push({ pitch: n.pitch, startBeat: current_offset + n.startBeatOffset, durationBeats: n.durationBeats, velocity: n.velocity });
            });

            // 侧链分支生成
            let branches = main_chain_branches[i];
            if (branches && branches.length > 0) {
                let branchTriggerTime = current_offset;

                // 分支起始提示音 (1.0 拍，不加交叠)
                allEvents.push({ pitch: 'C4', startBeat: branchTriggerTime, durationBeats: 1.0, velocity: VOL_BRANCH });

                let rel_t = 1.0;
                branches.forEach(b_idx => {
                    let b_atom = parsed.atoms_data[b_idx];
                    let b_notes = createNotesFromAtom(b_atom, true, VOL_BRANCH);
                    b_notes.forEach(n => {
                        allEvents.push({ pitch: n.pitch, startBeat: branchTriggerTime + rel_t + n.startBeatOffset, durationBeats: n.durationBeats, velocity: n.velocity });
                    });
                    rel_t += 1.0;
                });
            }
            // 核心机制：主时间轴绝对前进 1.0 拍，保证下一个音准时进场
            current_offset += 1.0;
        });

        return allEvents;
    }

    // 暴露给外部调用的主接口 (维持不变)
    window.generateScoreFromSmiles = function (smiles, bpm = 100) {
        let events = generateEvents(smiles);
        let msPerBeat = 60000 / bpm;

        let finalMidiEvents = events.map(e => ({
            time: Math.round(e.startBeat * msPerBeat),
            type: 'noteOn',
            note: noteNameToMidi(e.pitch),
            duration: Math.round(e.durationBeats * msPerBeat),
            velocity: e.velocity
        }));

        finalMidiEvents.sort((a, b) => a.time - b.time);
        return finalMidiEvents;
    };

})();