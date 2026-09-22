/**
 * MusicMol — WebGL 三维飘动层：音符 / 原子「分子」粒子
 * 依赖全局 THREE（r160+）
 */
(function () {
  const ATOM_COLOR = {
    C: 0x909090,
    N: 0x3050f8,
    O: 0xe01414,
    F: 0x90e050,
    Cl: 0x1fe01f,
    Br: 0xa62929,
    I: 0x940094,
    S: 0xffc832,
    Se: 0xffa100,
    Te: 0xd47b00,
    P: 0xff8000,
    As: 0xbd80e3,
    B: 0xffb5b5,
    Si: 0xf0c8a0,
    other: 0x888888,
  };

  function getAtomFromNoteName(noteName) {
    const cfg = typeof NoteConfig !== 'undefined' ? NoteConfig.specialAtomConfig : null;
    if (!cfg || !cfg.enabled) return null;
    const backbone = cfg.pitchMapBackbone || {};
    const branch = {};
    Object.keys(backbone).forEach((k) => {
      const p = backbone[k];
      if (typeof p === 'string') branch[k] = p.replace('5', '4');
    });
    const reverse = {};
    function add(m) {
      Object.entries(m || {}).forEach(([el, pitch]) => {
        if (!pitch) return;
        if (!reverse[pitch]) reverse[pitch] = [];
        reverse[pitch].push(el);
      });
    }
    add(backbone);
    add(branch);
    const targets = cfg.targetPitches || [];
    if (!targets.includes(noteName)) return null;
    const els = reverse[noteName];
    if (!els || !els.length) return null;
    return els[0];
  }

  function makeTextSprite(text, opts) {
    const fontSize = opts.fontSize || 96;
    const pad = 16;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${fontSize}px Merriweather, Georgia, serif`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    const h = fontSize + pad * 2;
    canvas.width = w;
    canvas.height = h;
    ctx.font = `bold ${fontSize}px Merriweather, Georgia, serif`;
    ctx.fillStyle = 'rgba(28,28,36,0.92)';
    ctx.strokeStyle = 'rgba(180,180,200,0.45)';
    ctx.lineWidth = 2;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.fillStyle = '#e8e8f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: true,
    });
    const sprite = new THREE.Sprite(mat);
    const sc = 1.15;
    sprite.scale.set((w / h) * sc, sc, 1);
    return sprite;
  }

  const MusicMolFX3D = {
    ready: false,
    scene: null,
    camera: null,
    renderer: null,
    wrap: null,
    items: [],
    maxItems: 48,
    raf: 0,

    init(wrapEl) {
      if (typeof THREE === 'undefined') return;
      this.wrap = wrapEl || document.getElementById('musicMolFxZone');
      const canvas = document.getElementById('musicmolFxCanvas');
      if (!this.wrap || !canvas) return;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
      this.camera.position.set(0, 1.35, 6.2);
      this.camera.lookAt(0, 0.45, 0);

      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setClearColor(0x000000, 0);

      this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const d1 = new THREE.DirectionalLight(0xfff5e8, 0.9);
      d1.position.set(-4, 6, 8);
      this.scene.add(d1);
      const d2 = new THREE.DirectionalLight(0xc8d4ff, 0.35);
      d2.position.set(5, 2, 4);
      this.scene.add(d2);

      this.ready = true;
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this._loop = this._loop.bind(this);
      this.raf = requestAnimationFrame(this._loop);
    },

    _resize() {
      if (!this.wrap || !this.renderer || !this.camera) return;
      const w = Math.max(1, this.wrap.clientWidth);
      const h = Math.max(1, this.wrap.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    },

    _screenToWorld(cx, cy) {
      const rect = this.wrap.getBoundingClientRect();
      const u = (cx - rect.left) / Math.max(1, rect.width);
      const v = (cy - rect.top) / Math.max(1, rect.height);
      const worldX = (u - 0.5) * 11;
      const worldY = (1 - v) * 5.2 - 1.1;
      const worldZ = (Math.random() - 0.5) * 1.6;
      return new THREE.Vector3(worldX, worldY, worldZ);
    },

    spawn(noteName, keyElementOrHint, _containerIgnored) {
      if (!this.ready || !this.wrap) return false;
      let cx;
      let cy;
      if (keyElementOrHint && typeof keyElementOrHint.getBoundingClientRect === 'function') {
        const rect = keyElementOrHint.getBoundingClientRect();
        cx = rect.left + rect.width / 2;
        cy = rect.top + rect.height * 0.35;
      } else if (
        keyElementOrHint &&
        typeof keyElementOrHint.keyIndex === 'number'
      ) {
        const wr = this.wrap.getBoundingClientRect();
        const n = Math.max(1, keyElementOrHint.totalKeys || 52);
        const u = (keyElementOrHint.keyIndex + 0.5) / n;
        cx = wr.left + u * wr.width;
        cy = wr.bottom - Math.min(80, wr.height * 0.35);
      } else {
        return false;
      }
      const pos = this._screenToWorld(cx, cy);

      const atom = getAtomFromNoteName(noteName);
      const group = new THREE.Group();
      group.position.copy(pos);

      if (atom) {
        const col = ATOM_COLOR[atom] || ATOM_COLOR.other;
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.42, 22, 22),
          new THREE.MeshStandardMaterial({
            color: col,
            roughness: 0.35,
            metalness: 0.15,
            emissive: col,
            emissiveIntensity: 0.12,
          })
        );
        group.add(core);
        const nSat = 5 + Math.floor(Math.random() * 4);
        for (let i = 0; i < nSat; i++) {
          const s = new THREE.Mesh(
            new THREE.SphereGeometry(0.14 + Math.random() * 0.1, 14, 14),
            new THREE.MeshStandardMaterial({
              color: col,
              roughness: 0.4,
              emissive: col,
              emissiveIntensity: 0.08,
            })
          );
          const th = Math.random() * Math.PI * 2;
          const ph = Math.random() * Math.PI;
          const rr = 0.55 + Math.random() * 0.35;
          s.position.set(
            rr * Math.sin(ph) * Math.cos(th),
            rr * Math.sin(ph) * Math.sin(th),
            rr * Math.cos(ph)
          );
          group.add(s);
        }
        const label = makeTextSprite(`${atom} · ${noteName}`, { fontSize: 88 });
        label.position.set(0, 0.75, 0);
        group.add(label);
      } else {
        const sym = ['♪', '♫', '♬', '𝄞'][Math.floor(Math.random() * 4)];
        const sprite = makeTextSprite(`${sym} ${noteName}`, { fontSize: 92 });
        group.add(sprite);
      }

      const life = 3.2 + Math.random() * 1.2;
      this.items.push({
        group,
        vy: 0.028 + Math.random() * 0.016,
        vx: (Math.random() - 0.5) * 0.012,
        vz: (Math.random() - 0.5) * 0.01,
        wx: (Math.random() - 0.5) * 0.04,
        wy: (Math.random() - 0.5) * 0.035,
        wz: (Math.random() - 0.5) * 0.03,
        t: 0,
        life,
      });
      this.scene.add(group);

      while (this.items.length > this.maxItems) {
        const old = this.items.shift();
        this.scene.remove(old.group);
        old.group.traverse((o) => {
          if (o.material) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
          }
          if (o.geometry) o.geometry.dispose();
        });
      }
      return true;
    },

    _loop() {
      this.raf = requestAnimationFrame(this._loop);
      if (!this.ready) return;
      const dt = 0.016;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        it.t += dt;
        it.group.position.x += it.vx + Math.sin(it.t * 2.1) * 0.002;
        it.group.position.y += it.vy;
        it.group.position.z += it.vz + Math.cos(it.t * 1.7) * 0.002;
        it.group.rotation.x += it.wx * dt;
        it.group.rotation.y += it.wy * dt;
        it.group.rotation.z += it.wz * dt;
        const f = 1 - it.t / it.life;
        it.group.scale.setScalar(Math.max(0.15, 0.55 + f * 0.5));
        it.group.traverse((o) => {
          if (o.isSprite && o.material) {
            o.material.transparent = true;
            o.material.opacity = Math.max(0, f);
          }
          if (o.isMesh && o.material) {
            o.material.transparent = true;
            o.material.opacity = Math.max(0, Math.min(1, f * 1.15));
          }
        });
        if (it.t >= it.life) {
          this.scene.remove(it.group);
          it.group.traverse((o) => {
            if (o.material) {
              if (o.material.map) o.material.map.dispose();
              o.material.dispose();
            }
            if (o.geometry) o.geometry.dispose();
          });
          this.items.splice(i, 1);
        }
      }
      this.renderer.render(this.scene, this.camera);
    },
  };

  window.MusicMolFX3D = MusicMolFX3D;

  document.addEventListener('DOMContentLoaded', () => {
    const wrap = document.getElementById('musicMolFxZone') || document.getElementById('keyboardFxWrap');
    if (wrap) MusicMolFX3D.init(wrap);
  });
})();
