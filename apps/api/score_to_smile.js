// score_to_smiles.js
// 智能宽容解释器：Music -> Fragment
// 基于动作模式识别，极大降低人类弹奏的容错率

(function () {
    // 宽容映射表：只看音名，不管八度
    const NoteMap = {
        0: 'C',   // C -> 碳
        2: 'S',   // D -> 硫
        4: 'Br',  // E -> 溴
        5: 'N',   // F -> 氮
        7: 'Cl',  // G -> 氯
        9: 'O',   // A -> 氧
        11: 'F'   // B -> 氟
    };

    function parseEventsToSmiles(rawEvents) {
        if (!rawEvents || rawEvents.length === 0) return "";

        // 【修复1：降噪过滤】过滤掉鼠标误触产生的极短碎片音 (小于 40ms 的直接扔掉)
        let validEvents = rawEvents.filter(e => e.duration > 40);
        if (validEvents.length === 0) return "";

        // 1. 按发生时间对有效事件排序
        let events = [...validEvents].sort((a, b) => a.start - b.start);

        // 2. 和弦打包窗格 (80ms内容忍)
        let chords = [];
        let currentChord = { start: events[0].start, notes: [events[0].note] };

        for (let i = 1; i < events.length; i++) {
            let ev = events[i];
            if (ev.start - currentChord.start <= 80) {
                currentChord.notes.push(ev.note);
            } else {
                chords.push(currentChord);
                currentChord = { start: ev.start, notes: [ev.note] };
            }
        }
        chords.push(currentChord);

        // 3. 状态机解析主逻辑
        let smiles = "";
        let inBranch = false;

        let i = 0;
        while (i < chords.length) {
            let chord = chords[i];

            // 【修复2：无压弹奏】已移除 1.5s 自动关闭的逻辑，完全依靠 C4(A键) 手动控制开关

            // 支链手动开关：精确匹配 C4 (MIDI 60) 且必须是单音
            if (chord.notes.includes(60) && chord.notes.length === 1) {
                if (!inBranch) {
                    smiles += "(";
                    inBranch = true;
                } else {
                    smiles += ")";
                    inBranch = false;
                }
                i++;
                continue;
            }

            // 获取当前组的基础音高
            let baseMidi = Math.min(...chord.notes);
            let noteClass = baseMidi % 12; // 取余数，无视八度
            let atom = NoteMap[noteClass] || 'C'; // 默认碳

            // 手性判断 (仅限碳原子)
            if (atom === 'C' && chord.notes.length > 1) {
                let hasE = chord.notes.some(n => n % 12 === 4); // 包含 E (大三度)
                let hasG = chord.notes.some(n => n % 12 === 7); // 包含 G (纯五度)
                if (hasE) atom = "[C@H]";       // 左旋
                else if (hasG) atom = "[C@@H]"; // 右旋
            }

            // 连击判定器 (检测后续是否有相同原子的快速敲击)
            let tapCount = 1;
            while (i + tapCount < chords.length) {
                let nextChord = chords[i + tapCount];
                // 如果两次敲击间隔小于 450ms
                if (nextChord.start - chords[i + tapCount - 1].start <= 450) {
                    let nextBase = Math.min(...nextChord.notes);
                    let nextAtom = NoteMap[nextBase % 12] || 'C';

                    // 如果连击的是同一个元素，且不是支链开关
                    if (nextAtom === atom && nextChord.notes.length === chord.notes.length && !nextChord.notes.includes(60)) {
                        tapCount++;
                        if (tapCount === 3) break; // 最多检测三连击
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }

            // 依据敲击次数拼接化学键
            if (smiles.length > 0 && !smiles.endsWith('(')) {
                if (tapCount === 2) smiles += "="; // 双击变双键
                if (tapCount === 3) smiles += "#"; // 三击变三键
            }
            smiles += atom;

            i += tapCount;
        }

        // 兜底：如果弹完了支链还没手动闭合，为了防崩溃自动闭合
        if (inBranch) smiles += ")";

        // 【修复3：清理视觉残留】如果生成了空的 ()，直接抹掉，不影响视觉和后端渲染
        smiles = smiles.replace(/\(\)/g, "");

        return smiles;
    }

    // 暴露接口给全局
    window.ReverseInterpreter = {
        parse: parseEventsToSmiles
    };
})();