// smile_to_score.js
// 基于 MusicMol 进阶规则：支持官能团和弦映射、杂化轨道音区映射、双/三键复杂节奏

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

        // 一次遍历，同时提取结构深度、原子的字符串位置（用于官能团匹配）和键类型
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
                hybrid: 'SP3', // 默认 SP3
                fg: null,
                strStart: startIdx,
                strEnd: endIdx
            });

            atom_indices.push(atom_counter);
            atom_depths.push(depth);
            atom_parent_main.push(parent);

            last_atom_idx = atom_counter;
            atom_counter++;
        }

        // 杂化轨道逆推规则：三键为SP，双键/芳香环为SP2，其他SP3
        atoms_data.forEach(a => {
            if (a.is_triple) a.hybrid = 'SP';
            else if (a.is_double || a.is_aromatic) a.hybrid = 'SP2';
        });

        // 模拟 RDKit 的官能团 SubstructMatch (基于字符串重叠判定)
        let fg_patterns = FUNCTIONAL_GROUPS.map(fg => {
            // 转义 SMARTS 中的正则特殊字符
            let escaped = fg.smarts.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
            return { regex: new RegExp(escaped, 'g'), fg: fg };
        });

        fg_patterns.forEach(patt => {
            let match;
            while ((match = patt.regex.exec(s)) !== null) {
                let matchStart = match.index;
                let matchEnd = match.index + match[0].length;

                // 给位于匹配字符串区间内的原子打上官能团标签
                atoms_data.forEach(a => {
                    if (a.strStart >= matchStart && a.strEnd <= matchEnd) {
                        if (!a.fg || a.fg.prio > patt.fg.prio) {
                            a.fg = patt.fg;
                        }
                    }
                });
            }
        });

        return { atom_indices, atom_depths, atom_parent_main, atoms_data };
    }

    // 2. 根据原子属性生成音符列表
    function generateEvents(smiles) {
        let parsed = parseRawSmiles(smiles);
        let allEvents = [];
        let current_offset = 0.0;

        let main_chain_atoms = parsed.atom_indices.filter((idx, i) => parsed.atom_depths[i] === 0);
        let main_chain_branches = main_chain_atoms.map(main_idx => {
            return parsed.atom_indices.filter((idx, i) => parsed.atom_parent_main[i] === main_idx);
        });

        function getPitchForAtom(atom, isBranch) {
            if (atom.fg) {
                let notes = atom.fg.notes;
                if (isBranch) notes = notes.map(n => n.replace('4', '3'));
                return { isChord: true, pitches: notes };
            } else {
                let pitch = (atom.symbol === 'C') ? (HYBRID_PITCH[atom.hybrid] || 'C5') : (ATOM_PITCH_MAP[atom.symbol] || ATOM_PITCH_MAP['other']);
                if (isBranch) pitch = pitch.replace(/(\d+)/, match => String(parseInt(match) - 1));
                return { isChord: false, pitch: pitch };
            }
        }

        function createNotesFromAtom(atom, isBranch, velocity) {
            let notes_list = [];
            let pObj = getPitchForAtom(atom, isBranch);

            function addNote(relTime, length) {
                if (pObj.isChord) {
                    pObj.pitches.forEach(p => notes_list.push({ pitch: p, startBeatOffset: relTime, durationBeats: length, velocity }));
                } else {
                    notes_list.push({ pitch: pObj.pitch, startBeatOffset: relTime, durationBeats: length, velocity });
                }
            }

            // 区分逻辑占位与实际发声长度，强制留出气口（抬手动作）
            // ⚠️ 注意：v2 版本的 addNote 参数顺序是 (相对时间 relTime, 发声时长 length)

            if (atom.is_triple) {
                // 【极度干脆】三连音：每次在对应的时间点，发声 0.12 拍
                addNote(0.0, 0.12);
                addNote(1 / 3, 0.12);
                addNote(2 / 3, 0.12);
            } else if (atom.is_double) {
                // 双键：在 0.0 和 0.5 的位置，发声 0.3 拍
                addNote(0.0, 0.3);
                addNote(0.5, 0.3);
            } else if (atom.is_aromatic) {
                // 【核心修复】芳香环：防吞音附点节奏
                addNote(0.0, 0.6);
                addNote(0.75, 0.15);
            } else if (atom.in_ring) {
                // 断奏
                addNote(0.0, 0.2);
            } else {
                // 普通单音：发声 0.85 拍，模拟呼吸感
                addNote(0.0, 0.85);
            }
            return notes_list;
        }

        // 组装时间线
        main_chain_atoms.forEach((atom_idx, i) => {
            let atom = parsed.atoms_data[atom_idx];
            let notes = createNotesFromAtom(atom, false, 110);

            notes.forEach(n => {
                allEvents.push({ pitch: n.pitch, startBeat: current_offset + n.startBeatOffset, durationBeats: n.durationBeats, velocity: n.velocity });
            });

            let branches = main_chain_branches[i];
            if (branches && branches.length > 0) {
                let branchTriggerTime = current_offset;
                // 分支起始提示音
                allEvents.push({ pitch: 'C4', startBeat: branchTriggerTime, durationBeats: 1.0, velocity: 77 });

                let rel_t = 1.0;
                branches.forEach(b_idx => {
                    let b_atom = parsed.atoms_data[b_idx];
                    let b_notes = createNotesFromAtom(b_atom, true, 77);
                    b_notes.forEach(n => {
                        allEvents.push({ pitch: n.pitch, startBeat: branchTriggerTime + rel_t + n.startBeatOffset, durationBeats: n.durationBeats, velocity: n.velocity });
                    });
                    rel_t += 1.0;
                });
            }
            current_offset += 1.0;
        });
        return allEvents;
    }

    // 3. 将音符名称转为 MIDI 标准数字格式
    function noteNameToMidi(n) {
        const m = n.match(/^([A-G])(#?)(\d+)$/);
        if (!m) return 60;
        const noteBase = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
        let semis = noteBase[m[1]] + (m[2] ? 1 : 0);
        return (parseInt(m[3], 10) + 1) * 12 + semis;
    }

    // 暴露给外部 piano.js 调用的主接口
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