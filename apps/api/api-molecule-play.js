/**
 * MusicMol 双向数据接口客户端
 * - POST /api/molecule_to_music  { smiles, bpm }
 * - POST /api/music_to_molecule   { events, bpm, push_outbound_smiles: true 则推理成功后外发 SMILES 到 8082 }
 */
(function () {
    const DEFAULT_BASE = "http://127.0.0.1:5020";

    function $(id) { return document.getElementById(id); }

    function getBaseUrl() {
        if (typeof location === "undefined" || !location.href) return DEFAULT_BASE;
        if (location.protocol === "file:") return DEFAULT_BASE;
        const p = location.port || (location.protocol === "https:" ? "443" : "80");
        const host = location.hostname || "127.0.0.1";
        const proto = location.protocol === "https:" ? "https:" : "http:";
        // 8766：PAINOJS；API 仍为 MusicMol :5020
        if (p === "8081" || p === "8766") return `${proto}//${host}:5020`.replace(/\/$/, "");
        if (p === "5020") return (location.origin || "").replace(/\/$/, "");
        return `${proto}//${host}:5020`.replace(/\/$/, "");
    }

    async function postJson(path, payload) {
        const url = getBaseUrl() + path;
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* ignore */ }
        return { ok: res.ok, status: res.status, json, text, url };
    }

    // ========== 分子 → 音乐 ==========
    window.moleculeToMusic = async function (smiles, bpm) {
        if (!smiles) return { ok: false, error: "SMILES 为空" };
        const result = await postJson("/api/molecule_to_music", { smiles, bpm });
        if (!result.ok || !result.json || !result.json.ok) {
            return {
                ok: false,
                error: result.json && result.json.error ? result.json.error : ("HTTP " + result.status),
            };
        }
        return { ok: true, midi_events: result.json.midi_events, meta: result.json.meta };
    };

    // ========== 音乐 → 分子 ==========
    window.musicToMolecule = async function (events, bpm) {
        if (!Array.isArray(events) || events.length === 0) {
            return { ok: false, error: "events 为空" };
        }
        const result = await postJson("/api/music_to_molecule", {
            events,
            bpm,
            push_outbound_smiles: true,
        });
        if (!result.ok || !result.json || !result.json.ok) {
            return {
                ok: false,
                error: result.json && result.json.error ? result.json.error : ("HTTP " + result.status),
            };
        }
        return { ok: true, best_smiles: result.json.best_smiles, meta: result.json.meta };
    };

    // ========== UI 绑定 ==========
    function unlockAudio() {
        if (window.MusicMolPiano && typeof window.MusicMolPiano.unlockAudio === "function") {
            window.MusicMolPiano.unlockAudio();
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        // 快速演奏：分子 → 音乐
        const quickBtn = $("quickPlayBtn");
        if (quickBtn) {
            quickBtn.addEventListener("click", async function () {
                unlockAudio();
                const smiles = ($("quickPlaySmiles") && $("quickPlaySmiles").value.trim()) || "";
                const bpm = parseInt(($("quickPlayBpm") && $("quickPlayBpm").value) || "100", 10) || 100;
                if (!smiles) return;

                const result = await window.moleculeToMusic(smiles, bpm);
                if (!result.ok) {
                    alert("分子到音乐失败: " + result.error);
                    return;
                }

                if (window.MusicMolPiano && typeof window.MusicMolPiano.stopPlayback === "function") {
                    window.MusicMolPiano.stopPlayback();
                }
                window.MusicMolPiano.setPlayMode("api");
                window.MusicMolPiano.playMidiEvents(result.midi_events);
            });
        }

        // 旧的调试面板按钮（如果存在）也绑定到新接口
        const oldBtn = $("apiMoleculeRequestPlayBtn");
        if (oldBtn) {
            oldBtn.addEventListener("click", async function () {
                unlockAudio();
                const smiles = ($("apiMoleculeSmiles") && $("apiMoleculeSmiles").value.trim()) || "";
                const bpm = parseInt(($("apiMoleculeBpm") && $("apiMoleculeBpm").value) || "100", 10) || 100;
                if (!smiles) return;
                const result = await window.moleculeToMusic(smiles, bpm);
                if (!result.ok) {
                    alert("分子到音乐失败: " + result.error);
                    return;
                }
                if (window.MusicMolPiano && typeof window.MusicMolPiano.stopPlayback === "function") {
                    window.MusicMolPiano.stopPlayback();
                }
                window.MusicMolPiano.setPlayMode("api");
                window.MusicMolPiano.playMidiEvents(result.midi_events);
            });
        }
    });
})();
