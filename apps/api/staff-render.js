// staff-render.js — VexFlow 实时五线谱渲染器
// 将所有音高映射到固定八度(C4-B4)显示，通过上下加点表示实际八度偏移

(function () {
  'use strict';

  const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

  /**
   * 将任意 MIDI 音符映射到固定显示音区 C4-B4(MIDI 60-71)，
   * 同时返回相对于 C4 的八度偏移量，用于上下加点。
   */
  function mapToFixedOctave(midiNote) {
    const rawOctave = Math.floor(midiNote / 12) - 1;
    // 固定到以 60(C4) 为基准的一个八度内
    const fixedMidi = ((midiNote - 60) % 12 + 12) % 12 + 60;
    const octaveShift = Math.floor((midiNote - 60) / 12);
    const name = NOTE_NAMES[fixedMidi % 12];
    return {
      key: name + '/4',          // VexFlow 显示用，固定在高音谱号中央八度
      rawName: name,
      rawOctave,
      octaveShift,               // >0 表示上方加点，<0 表示下方加点
    };
  }

  function durationToVexDuration(durationMs) {
    if (durationMs >= 1500) return 'w';
    if (durationMs >= 750) return 'h';
    if (durationMs >= 375) return 'q';
    if (durationMs >= 187) return '8';
    return '16';
  }

  class StaffRenderer {
    constructor(containerId, options = {}) {
      this.container = document.getElementById(containerId);
      if (!this.container) {
        console.warn('[StaffRenderer] container not found:', containerId);
        return;
      }
      this.maxNotes = options.maxNotes || 32;
      this.notes = []; // { midiNote, duration, durationMs }
      this.width = options.width || this.container.clientWidth || 1680;
      this.height = options.height || 140;
      this._initRenderer();
    }

    _initRenderer() {
      if (typeof Vex === 'undefined' || !Vex.Flow) {
        console.warn('[StaffRenderer] VexFlow not loaded');
        return;
      }
      this.renderer = new Vex.Flow.Renderer(this.container, Vex.Flow.Renderer.Backends.SVG);
      this.renderer.resize(this.width, this.height);
    }

    addNote(midiNote, durationMs) {
      if (!this.renderer) return;
      const duration = durationToVexDuration(durationMs);
      this.notes.push({ midiNote, duration, durationMs });
      if (this.notes.length > this.maxNotes) {
        this.notes.shift();
      }
      this.render();
    }

    clear() {
      this.notes = [];
      this.render();
    }

    render() {
      if (!this.renderer || !this.container) return;
      const containerW = this.container.clientWidth || this.width || 1680;
      this.width = containerW;
      this.container.innerHTML = '';
      this.renderer = new Vex.Flow.Renderer(this.container, Vex.Flow.Renderer.Backends.SVG);
      this.renderer.resize(this.width, this.height);
      const context = this.renderer.getContext();

      if (this.notes.length === 0) {
        const stave = new Vex.Flow.Stave(10, 20, this.width - 20);
        stave.addClef('treble');
        stave.setContext(context).draw();
        return;
      }

      const notesPerMeasure = 8;
      const measureWidth = Math.min(400, Math.floor((this.width - 40) / Math.ceil(this.notes.length / notesPerMeasure)));
      const measures = [];
      for (let i = 0; i < this.notes.length; i += notesPerMeasure) {
        measures.push(this.notes.slice(i, i + notesPerMeasure));
      }

      let x = 10;
      measures.forEach((measureNotes, idx) => {
        const w = (idx === measures.length - 1)
          ? Math.max(measureWidth, this.width - x - 20)
          : measureWidth;
        const staveY = 20;
        const stave = new Vex.Flow.Stave(x, staveY, w);
        if (idx === 0) {
          stave.addClef('treble');
        }
        stave.setContext(context).draw();

        const vexNotes = measureNotes.map(n => {
          const mapped = mapToFixedOctave(n.midiNote);
          const sn = new Vex.Flow.StaveNote({
            keys: [mapped.key],
            duration: n.duration,
            auto_stem: true,
          });

          // 升降号
          if (mapped.key.includes('#')) {
            sn.addModifier(new Vex.Flow.Accidental('#'), 0);
          } else if (mapped.key.includes('b')) {
            sn.addModifier(new Vex.Flow.Accidental('b'), 0);
          }

          // 八度偏移标记（上下加点）
          if (mapped.octaveShift !== 0) {
            const dotCount = Math.abs(mapped.octaveShift);
            const dots = '●'.repeat(dotCount);
            const ann = new Vex.Flow.Annotation(dots);
            if (mapped.octaveShift > 0) {
              // 高八度：点在上方
              ann.setVerticalJustification(Vex.Flow.Annotation.VerticalJustify.TOP);
            } else {
              // 低八度：点在下方
              ann.setVerticalJustification(Vex.Flow.Annotation.VerticalJustify.BOTTOM);
            }
            sn.addModifier(ann, 0);
          }

          return sn;
        });

        // 自动连接八分/十六分音符的符尾
        const beamNotes = vexNotes.filter(n =>
          n.duration === '8' || n.duration === '16' || n.duration === '8d' || n.duration === '16d'
        );
        let beams = [];
        if (beamNotes.length > 1) {
          beams.push(new Vex.Flow.Beam(beamNotes));
        }

        const voice = new Vex.Flow.Voice({ num_beats: 16, beat_value: 4 });
        voice.setStrict(false);
        voice.addTickables(vexNotes);

        new Vex.Flow.Formatter().joinVoices([voice]).format([voice], w - 20);
        voice.draw(context, stave);
        beams.forEach(b => b.setContext(context).draw());

        x += w;
      });

      // 将音符、符干、符尾、加点颜色设为白色
      const svg = this.container.querySelector('svg');
      if (svg) {
        let styleEl = svg.querySelector('style#staff-white-notes');
        if (!styleEl) {
          styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
          styleEl.id = 'staff-white-notes';
          styleEl.textContent = `
            .vf-notehead path, .vf-notehead rect,
            .vf-stem, .vf-stem rect,
            .vf-flag path, .vf-flag rect,
            .vf-beam path, .vf-beam rect,
            .vf-note path, .vf-note rect,
            .vf-modifiers path, .vf-modifiers text,
            .vf-accidental path, .vf-accidental text,
            .vf-annotation {
              fill: #ffffff !important;
              stroke: #ffffff !important;
            }
            text, .vf-text {
              fill: #ffffff !important;
            }
          `;
          svg.appendChild(styleEl);
        }
      }
    }
  }

  window.StaffRenderer = StaffRenderer;
})();
