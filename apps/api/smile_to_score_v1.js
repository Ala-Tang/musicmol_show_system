// smile_to_score.js
// 对应后端的 smile_to_score.py 规则，将 SMILES 解析为前端可播放的 MIDI 事件数组

(function () {
    const pitchMapBackbone = {
        'C': 'C5', 'N': 'F5', 'O': 'A5', 'F': 'B5',
        'Cl': 'G5', 'Br': 'E5', 'I': 'E5', 'At': 'E5',
        'S': 'D5', 'Se': 'D5', 'Te': 'D5',
        'P': 'C5', 'As': 'C5', 'B': 'C5', 'Si': 'C5', 'other': 'E6'
    };

    const pitchMapBranch = {};
    for (let key in pitchMapBackbone) {
        pitchMapBranch[key] = pitchMapBackbone[key].replace('5', '4');
    }

    // 1. 深度解析器 (支持手性提取)
    function parseSmilesStructure(s) {
        // 替换括号内容，提取手性后缀
        let s_clean = s.replace(/\[(.*?)\]/g, (match, content) => {
            let symbolMatch = content.match(/[A-Za-z]+/);
            let symbol = symbolMatch ? symbolMatch[0] : "";
            if (content.includes("@@")) return symbol + "_CHIRAL_R";
            if (content.includes("@")) return symbol + "_CHIRAL_L";
            return symbol;
        });

        let structure = [];
        let i = 0;
        let n = s_clean.length;
        let active_rings = new Set();

        while (i < n) {
            let char = s_clean[i];

            // 检测环标记
            if (/\d/.test(char)) {
                if (structure.length > 0) structure[structure.length - 1].in_ring = true;
                if (active_rings.has(char)) active_rings.delete(char);
                else active_rings.add(char);
                i++; continue;
            }

            if (['=', '#', '-', '/', '\\'].includes(char)) {
                i++; continue;
            }

            // 识别原子 (支持识别后缀)
            let match = s_clean.slice(i).match(/^(Cl_CHIRAL_[RL]|Br_CHIRAL_[RL]|[A-Z][a-z]_CHIRAL_[RL]|[A-Z]_CHIRAL_[RL]|Cl|Br|[A-Z][a-z]|[A-Z]|[a-z])/);
            let symbol_raw = match ? match[0] : char;
            i += match ? match[0].length : 1;

            // 检测分支
            let branches = [];
            while (i < n && s_clean[i] === '(') {
                let balance = 1; let start = i + 1; let end = start;
                while (balance > 0 && end < n) {
                    if (s_clean[end] === '(') balance++;
                    else if (s_clean[end] === ')') balance--;
                    end++;
                }
                branches.push(s_clean.slice(start, end - 1));
                i = end;
            }

            // 解析手性标记
            let chiral_type = 0; // 0: 无, 1: @, 2: @@
            let final_symbol = symbol_raw;
            if (symbol_raw.includes("_CHIRAL_L")) {
                final_symbol = symbol_raw.replace("_CHIRAL_L", ""); chiral_type = 1;
            }
            else if (symbol_raw.includes("_CHIRAL_R")) {
                final_symbol = symbol_raw.replace("_CHIRAL_R", ""); chiral_type = 2;
            }

            if (/^[A-Za-z]/.test(final_symbol)) {
                structure.push({
                    symbol: final_symbol.toUpperCase(),
                    is_aromatic: final_symbol.toLowerCase() === final_symbol,
                    in_ring: active_rings.size > 0,
                    is_double: false,
                    is_triple: false,
                    is_chiral: chiral_type,
                    branches: branches
                });
            }
        }

        // 双键和三键检测
        let backbone_str = "";
        let skip = 0;
        let s_super_clean = s_clean.replace(/_CHIRAL_L/g, "").replace(/_CHIRAL_R/g, "");
        for (let c of s_super_clean) {
            if (c === '(') skip++; else if (c === ')') skip--; else if (skip === 0) backbone_str += c;
        }

        let tokens = backbone_str.match(/Cl|Br|[A-Za-z]|=|#/g) || [];
        let atom_idx = 0;
        for (let t_i = 0; t_i < tokens.length; t_i++) {
            let token = tokens[t_i];
            if (token === '=' || token === '#') continue;
            if (atom_idx < structure.length) {
                structure[atom_idx].is_double = (t_i > 0 && tokens[t_i - 1] === '=') || (t_i < tokens.length - 1 && tokens[t_i + 1] === '=');
                structure[atom_idx].is_triple = (t_i > 0 && tokens[t_i - 1] === '#') || (t_i < tokens.length - 1 && tokens[t_i + 1] === '#');
                atom_idx++;
            }
        }
        return structure;
    }

    // 2. 将解析出的结构转化为音符事件序列
    function generateEvents(smiles) {
        let data = parseSmilesStructure(smiles);
        let allEvents = [];
        let currentOffset = 0.0;

        const VOL_BACKBONE = 110;
        const VOL_BRANCH = 77;

        // 辅助函数：根据规则生成相对节拍的音符
        function createNotes(item, pitchName, velocityVal) {
            let notesList = [];

            // 获取和声：如果是手性碳，生成和弦
            let getPitches = (pName) => {
                if (item.symbol === 'C' && item.is_chiral > 0) {
                    let harmony = item.is_chiral === 1 ? 'E' + pName.slice(-1) : 'G' + pName.slice(-1);
                    return [pName, harmony];
                }
                return [pName];
            };

            let addNote = (len, rel) => {
                getPitches(pitchName).forEach(p => {
                    notesList.push({ pitch: p, length: len, rel: rel, velocity: velocityVal });
                });
            };

            // 区分逻辑占位与实际发声长度，强制留出气口（抬手动作）
            if (item.is_triple) {
                // 三连音：发声 0.25，留出 0.08 的气口
                addNote(0.12, 0); addNote(0.12, 1 / 3); addNote(0.12, 2 / 3);
            } else if (item.is_double) {
                // 双键：发声 0.35，留出 0.15 的气口
                addNote(0.3, 0); addNote(0.3, 0.5);
            } else if (item.is_aromatic) {
                // 【关键修复】芳香环核心：第一音发声 0.6，第二音发声 0.15。杜绝吞音！
                addNote(0.6, 0); addNote(0.15, 0.75);
            } else if (item.in_ring) {
                // 断奏：发声 0.2
                addNote(0.2, 0);
            } else {
                // 普通单音：发声 0.85，模拟呼吸感
                addNote(0.85, 0);
            }
            return notesList;
        }

        // 遍历主链
        for (let item of data) {
            let sym = item.symbol;
            let p = pitchMapBackbone[sym] || pitchMapBackbone['other'];
            let v1Notes = createNotes(item, p, VOL_BACKBONE);

            v1Notes.forEach(n => {
                allEvents.push({ pitch: n.pitch, startBeat: currentOffset + n.rel, durationBeats: n.length, velocity: n.velocity });
            });

            // 遍历支链
            if (item.branches && item.branches.length > 0) {
                let branchTriggerTime = currentOffset;
                for (let bStr of item.branches) {
                    let branchData = parseSmilesStructure(bStr);
                    // 支链开头的 C4 提示音
                    allEvents.push({ pitch: 'C4', startBeat: branchTriggerTime, durationBeats: 1.0, velocity: VOL_BRANCH });

                    let relT = 1.0;
                    for (let bItem of branchData) {
                        let bSym = bItem.symbol;
                        let bP = pitchMapBranch[bSym] || pitchMapBranch['other'];
                        let bNotes = createNotes(bItem, bP, VOL_BRANCH);
                        bNotes.forEach(n => {
                            allEvents.push({ pitch: n.pitch, startBeat: branchTriggerTime + relT + n.rel, durationBeats: n.length, velocity: n.velocity });
                        });
                        relT += 1.0;
                    }
                }
            }
            currentOffset += 1.0;
        }
        return allEvents;
    }

    // 3. 将相对节拍转换为毫秒和 MIDI 编号，供 piano.js 使用
    function noteNameToMidi(n) {
        const m = n.match(/^([A-G])(#?)(\d+)$/);
        if (!m) return 60;
        const name = m[1], sharp = m[2], octave = parseInt(m[3], 10);
        const noteBase = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
        let semis = noteBase[name] + (sharp ? 1 : 0);
        return (octave + 1) * 12 + semis;
    }

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

        // 按时间排序
        finalMidiEvents.sort((a, b) => a.time - b.time);
        return finalMidiEvents;
    };

})();