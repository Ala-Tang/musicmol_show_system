/**
 * MusicMol — 1920×360 纯 Three.js 钢琴（木质清漆光面、黑键优先拾取）
 */
(function () {
  const OUT_W = 1920;
  /** 琴键区画布高度（与视口一致，无顶栏） */
  const OUT_H = 360;

  const PHYS = {
    rest: 0,
    pressed: -0.082,
    stiffnessDown: 400,
    stiffnessUp: 500,
    dampingDown: 15,
    dampingUp: 11.5,
    mass: 1,
  };

  /** three.js examples RoundedBoxGeometry（圆角盒体，替代直角 Box） */
  const _tempNormal = new THREE.Vector3();
  function getUv(faceDirVector, normal, uvAxis, projectionAxis, radius, sideLength) {
    const totArcLength = (2 * Math.PI * radius) / 4;
    const centerLength = Math.max(sideLength - 2 * radius, 0);
    const halfArc = Math.PI / 4;
    _tempNormal.copy(normal);
    _tempNormal[projectionAxis] = 0;
    _tempNormal.normalize();
    const arcUvRatio = 0.5 * totArcLength / (totArcLength + centerLength);
    const arcAngleRatio = 1.0 - _tempNormal.angleTo(faceDirVector) / halfArc;
    if (Math.sign(_tempNormal[uvAxis]) === 1) {
      return arcAngleRatio * arcUvRatio;
    }
    const lenUv = centerLength / (totArcLength + centerLength);
    return lenUv + arcUvRatio + arcUvRatio * (1.0 - arcAngleRatio);
  }
  class RoundedBoxGeometry extends THREE.BoxGeometry {
    constructor(width = 1, height = 1, depth = 1, segments = 4, radius = 0.1) {
      let seg = segments * 2 + 1;
      radius = Math.min(width / 2, height / 2, depth / 2, radius);
      super(1, 1, 1, seg, seg, seg);
      if (seg === 1) return;
      const geometry2 = this.toNonIndexed();
      this.index = null;
      this.attributes.position = geometry2.attributes.position;
      this.attributes.normal = geometry2.attributes.normal;
      this.attributes.uv = geometry2.attributes.uv;
      const position = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const box = new THREE.Vector3(width, height, depth).divideScalar(2).subScalar(radius);
      const positions = this.attributes.position.array;
      const normals = this.attributes.normal.array;
      const uvs = this.attributes.uv.array;
      const faceTris = positions.length / 6;
      const faceDirVector = new THREE.Vector3();
      const halfSegmentSize = 0.5 / seg;
      for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
        position.fromArray(positions, i);
        normal.copy(position);
        normal.x -= Math.sign(normal.x) * halfSegmentSize;
        normal.y -= Math.sign(normal.y) * halfSegmentSize;
        normal.z -= Math.sign(normal.z) * halfSegmentSize;
        normal.normalize();
        positions[i + 0] = box.x * Math.sign(position.x) + normal.x * radius;
        positions[i + 1] = box.y * Math.sign(position.y) + normal.y * radius;
        positions[i + 2] = box.z * Math.sign(position.z) + normal.z * radius;
        normals[i + 0] = normal.x;
        normals[i + 1] = normal.y;
        normals[i + 2] = normal.z;
        const side = Math.floor(i / faceTris);
        switch (side) {
          case 0:
            faceDirVector.set(1, 0, 0);
            uvs[j + 0] = getUv(faceDirVector, normal, 'z', 'y', radius, depth);
            uvs[j + 1] = 1.0 - getUv(faceDirVector, normal, 'y', 'z', radius, height);
            break;
          case 1:
            faceDirVector.set(-1, 0, 0);
            uvs[j + 0] = 1.0 - getUv(faceDirVector, normal, 'z', 'y', radius, depth);
            uvs[j + 1] = 1.0 - getUv(faceDirVector, normal, 'y', 'z', radius, height);
            break;
          case 2:
            faceDirVector.set(0, 1, 0);
            uvs[j + 0] = 1.0 - getUv(faceDirVector, normal, 'x', 'z', radius, width);
            uvs[j + 1] = getUv(faceDirVector, normal, 'z', 'x', radius, depth);
            break;
          case 3:
            faceDirVector.set(0, -1, 0);
            uvs[j + 0] = 1.0 - getUv(faceDirVector, normal, 'x', 'z', radius, width);
            uvs[j + 1] = 1.0 - getUv(faceDirVector, normal, 'z', 'x', radius, depth);
            break;
          case 4:
            faceDirVector.set(0, 0, 1);
            uvs[j + 0] = 1.0 - getUv(faceDirVector, normal, 'x', 'y', radius, width);
            uvs[j + 1] = 1.0 - getUv(faceDirVector, normal, 'y', 'x', radius, height);
            break;
          case 5:
            faceDirVector.set(0, 0, -1);
            uvs[j + 0] = getUv(faceDirVector, normal, 'x', 'y', radius, width);
            uvs[j + 1] = 1.0 - getUv(faceDirVector, normal, 'y', 'x', radius, height);
            break;
        }
      }
    }
  }

  function createPiano941Viewer() {
    return {
    ready: false,
    piano: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    keyboardRoot: null,
    keys: [],
    meshToIndex: new Map(),
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    activeIndex: null,
    _dragging: false,
    /** 接口演奏时琴键上的短暂扩散环 */
    _apiRipples: [],

    init(canvasEl, pianoInstance, options) {
      if (typeof THREE === 'undefined' || !canvasEl || !pianoInstance) return;
      options = options || {};
      this.keyStandard = options.keyStandard === 'gb' ? 'gb' : 'legacy';
      const isGb = this.keyStandard === 'gb';
      this.piano = pianoInstance;
      this.canvas = canvasEl;
      this.keys = [];
      this.meshToIndex.clear();

      const renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
      renderer.setSize(OUT_W, OUT_H, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const useShadowMap = !isGb;
      renderer.shadowMap.enabled = useShadowMap;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = isGb ? 1.28 : 1.14;
      this.renderer = renderer;

      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(new THREE.AmbientLight(0xffffff, 0.38));
      const el = new THREE.DirectionalLight(0xfff2ec, 2.05);
      el.position.set(2, 5, 3);
      envScene.add(el);
      const el2 = new THREE.DirectionalLight(0xd0e0ff, 1.35);
      el2.position.set(-4, 2.5, -2);
      envScene.add(el2);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(4, 32, 32),
        new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 0.08, metalness: 0.06 })
      );
      ball.position.set(0, 0, -3);
      envScene.add(ball);
      const envRT = pmrem.fromScene(envScene, 0);
      pmrem.dispose();

      const scene = new THREE.Scene();
      /* 勿与黑键同色：黑键在画面下半占比大，背景过黑会像「半截没渲染」 */
      scene.background = new THREE.Color(0x14141a);
      scene.environment = envRT.texture;
      this.scene = scene;

      const notes = pianoInstance.notes;
      let whiteCount = 0;
      notes.forEach((n) => {
        if (!n.isBlack) whiteCount++;
      });
      if (whiteCount < 1) return;
      this._whiteKeyCount = whiteCount;
      /*
       * 约束：键区画布 OUT_W×OUT_H = 1920×360 px。
       * 键列模型总宽 KEYBOARD_X_SPAN=8.58（与主钢琴一致），白键均分：WHITE_W = 8.58 / whiteCount。
       * 已核对：主钢琴 generateNotesStandard → 24 白 → WHITE_W=8.58/24=0.3575；
       *         扩展 generateNotesExtended（C1 起，6 组截断至 E6）→ 38 白、27 黑、共 65 键 → WHITE_W=8.58/38≈0.22579。
       */
      const KEYBOARD_X_SPAN = 8.58;
      const WHITE_W = KEYBOARD_X_SPAN / whiteCount;

      let WHITE_D;
      let BLACK_W;
      let BLACK_D;
      let WHITE_H;
      let BLACK_H;
      let BLACK_ABOVE;

      let blackPivotZ = -0.055;
      if (this.keyStandard === 'gb') {
        /*
         * GB/T 10159-2023、QB/T 4131-2010 等：白键宽 23.5 mm、高 22 mm；黑键尺寸见下式。
         * 黑键 z：以当前白键几何深 kd 为基准，用「全长差」(kd−kbd) 与条文 51/150 做比例后退，白键不动。
         */
        const W0 = 23.5;
        const GB_WHITE_TOTAL_DEPTH_MM = 150;
        WHITE_D = WHITE_W * (GB_WHITE_TOTAL_DEPTH_MM / W0);
        BLACK_W = WHITE_W * (11.75 / W0);
        BLACK_D = WHITE_W * (95 / W0);
        WHITE_H = WHITE_W * (22 / W0);
        BLACK_H = WHITE_H * (11.75 / 22);
        BLACK_ABOVE = WHITE_W * (0.6 / W0);
        const whitePivotZ = 0.02;
        const whitePlayerZLocal = 0.04;
        const blackPlayerZLocal = 0.03;
        const kdMesh = WHITE_D * 0.993;
        const kbdMesh = BLACK_D * 0.992;
        const depthDelta = Math.max(0, kdMesh - kbdMesh);
        /** 后退量 = 全长差 × (51 mm / 150 mm)，等价于 kd×(51/150)×(depthDelta/kd)，比整段 WHITE_D×51/150 更短 */
        const setback = depthDelta * (51 / GB_WHITE_TOTAL_DEPTH_MM);
        blackPivotZ =
          whitePivotZ + whitePlayerZLocal - setback - blackPlayerZLocal;
      } else {
        /* 通用示意比例（非国标块） */
        const WHITE_DEPTH_TO_WIDTH = 150 / 23.5;
        const BLACK_WIDTH_TO_WHITE_WIDTH = 13.7 / 23.5;
        const BLACK_DEPTH_TO_WHITE_DEPTH = 105 / 150;
        WHITE_D = WHITE_W * WHITE_DEPTH_TO_WIDTH;
        BLACK_W = WHITE_W * BLACK_WIDTH_TO_WHITE_WIDTH;
        BLACK_D = WHITE_D * BLACK_DEPTH_TO_WHITE_DEPTH;
        WHITE_H = 0.12;
        BLACK_H = WHITE_H * 0.7;
        BLACK_ABOVE = 0.014;
      }
      const blackPivotY = WHITE_H + BLACK_ABOVE + BLACK_H * 0.5;
      const offset = WHITE_W - BLACK_W / 2;
      const totalWhiteWidth = whiteCount * WHITE_W;
      const centerShift = totalWhiteWidth / 2;

      const whiteMat = new THREE.MeshPhysicalMaterial({
        color: 0xf3ebe2,
        roughness: 0.09,
        metalness: 0.04,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMapIntensity: 1.5,
        specularIntensity: 1.28,
        specularColor: new THREE.Color(0xffffff),
        ior: 1.48,
      });
      const blackMat = new THREE.MeshPhysicalMaterial({
        color: 0x2a2a36,
        roughness: 0.12,
        metalness: 0.16,
        clearcoat: 1,
        clearcoatRoughness: 0.055,
        envMapIntensity: 1.15,
        specularIntensity: 1.05,
        specularColor: new THREE.Color(0xc8d4f0),
        ior: 1.55,
        emissive: new THREE.Color(0x0a0a12),
        emissiveIntensity: 0.14,
      });

      const keyboardRoot = new THREE.Group();
      this.keyboardRoot = keyboardRoot;
      scene.add(keyboardRoot);

      let whiteKeyCount = 0;
      notes.forEach((noteData, index) => {
        if (!noteData.isBlack) {
          const left = whiteKeyCount * WHITE_W;
          const x0 = left + WHITE_W * 0.48 - centerShift;
          const pivot = new THREE.Group();
          pivot.position.set(x0, WHITE_H * 0.5 + 0.001, 0.02);
          keyboardRoot.add(pivot);

          const kw = WHITE_W * 0.997;
          const kd = WHITE_D * 0.993;
          const kRad = Math.min(0.1, kw * 0.11, WHITE_H * 0.38, kd * 0.048);
          const geo = new RoundedBoxGeometry(kw, WHITE_H, kd, 4, kRad);
          geo.translate(0, 0, -kd * 0.5 + 0.04);
          const mesh = new THREE.Mesh(geo, whiteMat.clone());
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          pivot.add(mesh);

          this.keys[index] = {
            pivot,
            mesh,
            index,
            isBlack: false,
            angle: 0,
            vel: 0,
            pressed: false,
            target: PHYS.rest,
            stiff: PHYS.stiffnessUp,
            damp: PHYS.dampingUp,
          };
          this.meshToIndex.set(mesh, index);
          whiteKeyCount++;
        } else {
          const left = (whiteKeyCount - 1) * WHITE_W + offset;
          const x0 = left + BLACK_W / 2 - centerShift;
          const pivot = new THREE.Group();
          pivot.position.set(x0, blackPivotY, blackPivotZ);
          keyboardRoot.add(pivot);

          const kbw = BLACK_W * 0.992;
          const kbd = BLACK_D * 0.992;
          const bRad = Math.min(0.036, kbw * 0.14, BLACK_H * 0.32, kbd * 0.038);
          const geo = new RoundedBoxGeometry(kbw, BLACK_H, kbd, 3, bRad);
          geo.translate(0, 0, -kbd * 0.5 + 0.03);
          const mesh = new THREE.Mesh(geo, blackMat.clone());
          /* GB 黑键比白键深得多，castShadow 会在白键顶面拉出大片暗区，观感像「半幅发黑」 */
          mesh.castShadow = this.keyStandard !== 'gb';
          mesh.receiveShadow = true;
          mesh.renderOrder = 1;
          mesh.material.polygonOffset = true;
          mesh.material.polygonOffsetFactor = -0.8;
          mesh.material.polygonOffsetUnits = -0.8;
          pivot.add(mesh);

          this.keys[index] = {
            pivot,
            mesh,
            index,
            isBlack: true,
            angle: 0,
            vel: 0,
            pressed: false,
            target: PHYS.rest,
            stiff: PHYS.stiffnessUp,
            damp: PHYS.dampingUp,
          };
          this.meshToIndex.set(mesh, index);
        }
      });

      /*
       * -PI/2 且无 z 镜像时，国标长黑键易整段落在正交投影视锥外 → 屏上「只有白键」。
       * 保持 +PI/2 + scale.z=-1 以稳定出图；国标块用 blackPivotZ 镜像（见上）纠正前后。
       */
      keyboardRoot.rotation.x = Math.PI / 2;
      keyboardRoot.scale.set(1, 1, -1);

      scene.updateMatrixWorld(true);
      const bbox = new THREE.Box3().setFromObject(keyboardRoot);
      const c = new THREE.Vector3();
      bbox.getCenter(c);
      keyboardRoot.position.sub(c);
      scene.updateMatrixWorld(true);
      const bb2 = new THREE.Box3().setFromObject(keyboardRoot);
      const aspect = OUT_W / OUT_H;
      const pad = isGb ? 1.05 : 1.05;
      const camZoom = isGb ? 1 : 1.065;

      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 120);
      camera.position.set(0, 0.06, 3.1);
      camera.lookAt(0, 0.02, 0);
      camera.zoom = camZoom;
      camera.updateMatrixWorld(true);

      /*
       * 正交相机的 left/right、top/bottom 在相机局部 XY。键盘 rotation.x = PI/2 后，
       * 世界 AABB 的 (max.y-min.y) 不是画面竖直方向真实跨度，竖向视锥偏小会裁出半截黑底（主琴与国标都会出现）。
       * 将包围盒 8 顶点变换到 matrixWorldInverse 后取相机 X/Y 极值再算 halfW/halfH。
       */
      const invCam = camera.matrixWorldInverse;
      const corner = new THREE.Vector3();
      let minCx = Infinity;
      let maxCx = -Infinity;
      let minCy = Infinity;
      let maxCy = -Infinity;
      const xb = [bb2.min.x, bb2.max.x];
      const yb = [bb2.min.y, bb2.max.y];
      const zb = [bb2.min.z, bb2.max.z];
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          for (let c = 0; c < 2; c++) {
            corner.set(xb[a], yb[b], zb[c]).applyMatrix4(invCam);
            minCx = Math.min(minCx, corner.x);
            maxCx = Math.max(maxCx, corner.x);
            minCy = Math.min(minCy, corner.y);
            maxCy = Math.max(maxCy, corner.y);
          }
        }
      }
      const spanFitX = maxCx - minCx;
      const spanFitY = maxCy - minCy;

      const minW = (spanFitX * pad * camZoom) / 2;
      const minH = (spanFitY * pad * camZoom) / 2;
      let halfH = Math.max(minH, minW / aspect);
      let halfW = halfH * aspect;
      for (let i = 0; i < 6; i++) {
        if (2 * halfW < spanFitX * pad * camZoom) {
          halfW = (spanFitX * pad * camZoom) / 2;
          halfH = halfW / aspect;
        }
        if (2 * halfH < spanFitY * pad * camZoom) {
          halfH = (spanFitY * pad * camZoom) / 2;
          halfW = halfH * aspect;
        }
      }

      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
      this.camera = camera;

      /** 国标：竖向对称留白时把画布「下空」收到约该值（CSS px，相对 OUT_H） */
      this._layoutBottomTargetPx = isGb ? 30 : 0;

      if (isGb && this._layoutBottomTargetPx > 0) {
        const visHFit = (2 * halfH) / camZoom;
        const keysHPxEst = spanFitY * (OUT_H / visHFit);
        const slackV = Math.max(0, OUT_H - keysHPxEst);
        const symM = slackV / 2;
        const shiftPx = symM - this._layoutBottomTargetPx;
        if (Math.abs(shiftPx) > 0.25) {
          const dyWorld = (-shiftPx * visHFit) / OUT_H;
          keyboardRoot.position.y += dyWorld;
          scene.updateMatrixWorld(true);
          const bbPan = new THREE.Box3().setFromObject(keyboardRoot);
          let minCyP = Infinity;
          let maxCyP = -Infinity;
          const XP = [bbPan.min.x, bbPan.max.x];
          const YP = [bbPan.min.y, bbPan.max.y];
          const ZP = [bbPan.min.z, bbPan.max.z];
          for (let a = 0; a < 2; a++) {
            for (let b = 0; b < 2; b++) {
              for (let c = 0; c < 2; c++) {
                corner.set(XP[a], YP[b], ZP[c]).applyMatrix4(camera.matrixWorldInverse);
                minCyP = Math.min(minCyP, corner.y);
                maxCyP = Math.max(maxCyP, corner.y);
              }
            }
          }
          const spanYP = maxCyP - minCyP;
          if (spanYP * pad * camZoom > 2 * halfH - 1e-5) {
            let halfHp = Math.max((spanYP * pad * camZoom) / 2, (spanFitX * pad * camZoom) / (2 * aspect));
            let halfWp = halfHp * aspect;
            for (let i = 0; i < 6; i++) {
              if (2 * halfWp < spanFitX * pad * camZoom) {
                halfWp = (spanFitX * pad * camZoom) / 2;
                halfHp = halfWp / aspect;
              }
              if (2 * halfHp < spanYP * pad * camZoom) {
                halfHp = (spanYP * pad * camZoom) / 2;
                halfWp = halfHp * aspect;
              }
            }
            halfH = halfHp;
            halfW = halfWp;
            camera.left = -halfW;
            camera.right = halfW;
            camera.top = halfH;
            camera.bottom = -halfH;
            camera.updateProjectionMatrix();
          }
        }
      }

      this._layout = { OUT_W, OUT_H, halfW, halfH, spanX: spanFitX, spanY: spanFitY };
      this._keyDims = {
        whiteW: WHITE_W * 0.997,
        whiteD: WHITE_D * 0.993,
        blackW: BLACK_W * 0.992,
        blackD: BLACK_D * 0.992,
      };

      const sun = new THREE.DirectionalLight(0xfff6ee, 1.05);
      sun.position.set(-2.2, 4.5, 5);
      sun.castShadow = useShadowMap;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 0.2;
      sun.shadow.camera.far = 20;
      sun.shadow.camera.left = -6;
      sun.shadow.camera.right = 6;
      sun.shadow.camera.top = 4;
      sun.shadow.camera.bottom = -4;
      sun.shadow.bias = -0.0002;
      scene.add(sun);
      scene.add(new THREE.AmbientLight(0xffffff, isGb ? 0.44 : 0.28));
      const fill = new THREE.DirectionalLight(0xd8e2ff, isGb ? 0.55 : 0.42);
      fill.position.set(3, 2, 3);
      scene.add(fill);
      const glossPt = new THREE.PointLight(0xffffff, isGb ? 0.78 : 0.62, 45, 1.8);
      glossPt.position.set(0.4, 4.8, 5.2);
      scene.add(glossPt);
      const specSide = new THREE.DirectionalLight(0xfff8f0, isGb ? 0.62 : 0.55);
      specSide.position.set(4.5, 3.2, 2);
      scene.add(specSide);
      const bounce = new THREE.HemisphereLight(
        0x8898b8,
        isGb ? 0x3c3c48 : 0x282830,
        isGb ? 0.5 : 0.38
      );
      scene.add(bounce);
      const under = new THREE.DirectionalLight(0xd8e2f5, isGb ? 0.52 : 0.38);
      under.position.set(0.15, -4.2, 5.8);
      scene.add(under);

      this._onDown = this._onDown.bind(this);
      this._onUp = this._onUp.bind(this);
      this._onMove = this._onMove.bind(this);
      canvasEl.addEventListener('mousedown', this._onDown);
      window.addEventListener('mouseup', this._onUp);
      canvasEl.addEventListener('mousemove', this._onMove);
      canvasEl.addEventListener('touchstart', this._onDown, { passive: false });
      window.addEventListener('touchend', this._onUp);
      window.addEventListener('touchcancel', this._onUp);
      canvasEl.addEventListener('touchmove', this._onMove, { passive: false });

      this._tick = this._tick.bind(this);
      this._apiRipples = [];
      requestAnimationFrame(this._tick);

      this.ready = true;
    },

    _prepareKeyEmissive(st) {
      if (!st || !st.mesh || !st.mesh.material || st._emiPrepared) return;
      const m = st.mesh.material;
      st._emiColBase = m.emissive.clone();
      st._emiIntBase = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 0;
      st._emiHot = new THREE.Color(st.isBlack ? 0xaaddff : 0x55b6ff);
      st._emiPrepared = true;
      if (typeof st.apiGlowT !== 'number') st.apiGlowT = 0;
    },

    /** 接口数据演奏：键顶一圈高亮扩散（外径不超过约两个白键宽） */
    _spawnApiRipple(index) {
      const st = this.keys[index];
      if (!st || !st.mesh) return;
      const box = new THREE.Box3().setFromObject(st.mesh);
      const size = box.getSize(new THREE.Vector3());
      const whiteW =
        this._keyDims && typeof this._keyDims.whiteW === 'number' ? this._keyDims.whiteW : size.x * 1.05;
      const maxOuterRadius = whiteW * 0.98;
      const rIn = Math.max(0.008, Math.min(size.x, size.z) * 0.09);
      let rOut = rIn * 1.55;
      if (rOut > maxOuterRadius * 0.92) rOut = maxOuterRadius * 0.92;
      if (rOut <= rIn * 1.08) rOut = rIn * 1.08;
      const geo = new THREE.RingGeometry(rIn, rOut, 36);
      const mat = new THREE.MeshBasicMaterial({
        color: st.isBlack ? 0x99eeff : 0x66ccff,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, size.y * 0.52, -size.z * 0.28);
      ring.name = 'apiPlayRipple';
      ring.userData.maxScale = Math.max(1, Math.min(1.72, maxOuterRadius / rOut));
      st.mesh.add(ring);
      this._apiRipples.push({ mesh: ring, age: 0 });
    },

    /** 离开接口模式或停止自动演奏时清理发光与环 */
    resetApiKeyFx() {
      (this._apiRipples || []).forEach((r) => {
        if (!r.mesh) return;
        const p = r.mesh.parent;
        if (p) p.remove(r.mesh);
        if (r.mesh.geometry) r.mesh.geometry.dispose();
        if (r.mesh.material) r.mesh.material.dispose();
      });
      this._apiRipples = [];
      this.keys.forEach((st) => {
        if (!st || !st.mesh || !st.mesh.material || !st._emiPrepared) return;
        const m = st.mesh.material;
        m.emissive.copy(st._emiColBase);
        m.emissiveIntensity = st._emiIntBase;
        st.apiGlowT = 0;
      });
    },

    /** 根据正交相机与键几何估算画布内留白与单键像素尺寸（用于页面标注） */
    getLayoutPixelSizes() {
      if (!this._layout || !this._keyDims || !this.camera || !this.canvas) return null;
      const { OUT_W, OUT_H, halfW, halfH, spanX, spanY } = this._layout;
      const z = this.camera.zoom;
      const visW = (2 * halfW) / z;
      const visH = (2 * halfH) / z;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = rect.width / OUT_W;
      const scaleY = rect.height / OUT_H;
      const sx = (OUT_W / visW) * scaleX;
      const sy = (OUT_H / visH) * scaleY;
      const keysWPx = spanX * sx;
      const keysHPx = spanY * sy;
      const marginX = Math.max(0, (rect.width - keysWPx) / 2);
      const slackV = Math.max(0, rect.height - keysHPx);
      const marginY = slackV / 2;
      let marginTopPx = Math.round(marginY);
      let marginBotPx = Math.round(marginY);
      if (this._layoutBottomTargetPx > 0) {
        const mb = Math.min(this._layoutBottomTargetPx, slackV);
        marginBotPx = Math.round(mb);
        marginTopPx = Math.round(slackV - mb);
      }
      const { whiteW, whiteD, blackW, blackD } = this._keyDims;
      const round2 = (v) => Math.round(v * 100) / 100;
      const notes = this.piano && this.piano.notes ? this.piano.notes : [];
      const totalKeys = notes.length;
      let wk = typeof this._whiteKeyCount === 'number' ? this._whiteKeyCount : 0;
      if (!wk && notes.length) {
        notes.forEach((n) => {
          if (!n.isBlack) wk++;
        });
      }
      const blackKeyCount = Math.max(0, totalKeys - wk);
      return {
        /* 四边 margin 相对键区画布 OUT_W×OUT_H */
        marginX: Math.round(marginX),
        marginY: Math.round(marginY),
        marginTopPx,
        marginBotPx,
        keysWPx: Math.round(keysWPx),
        keysHPx: Math.round(keysHPx),
        whiteWpx: Math.round(whiteW * sx),
        whiteDpx: Math.round(whiteD * sy),
        blackWpx: Math.round(blackW * sx),
        blackDpx: Math.round(blackD * sy),
        canvasCssW: round2(rect.width),
        canvasCssH: round2(rect.height),
        totalKeys,
        whiteKeyCount: wk,
        blackKeyCount,
      };
    },

    _pick(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
      this.pointer.set(nx, ny);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const meshes = this.keys.filter(Boolean).map((k) => k.mesh);
      const hits = this.raycaster.intersectObjects(meshes, false);
      if (!hits.length) return null;
      hits.sort((a, b) => {
        const ia = this.meshToIndex.get(a.object);
        const ib = this.meshToIndex.get(b.object);
        const ka = this.keys[ia];
        const kb = this.keys[ib];
        if (ka && kb) {
          if (ka.isBlack && !kb.isBlack) return -1;
          if (!ka.isBlack && kb.isBlack) return 1;
        }
        return a.distance - b.distance;
      });
      return this.meshToIndex.get(hits[0].object);
    },

    _pointerInputEnabled() {
      return !this.piano || this.piano.playMode !== 'api';
    },

    _onDown(ev) {
      if (!this._pointerInputEnabled()) return;
      ev.preventDefault();
      const cx = ev.clientX ?? ev.touches?.[0]?.clientX;
      const cy = ev.clientY ?? ev.touches?.[0]?.clientY;
      if (this.piano && this.piano.initAudio) this.piano.initAudio();
      const idx = this._pick(cx, cy);
      if (idx != null) {
        this._dragging = true;
        this.activeIndex = idx;
        this.piano.startNote(idx, null);
      }
    },

    _onUp() {
      if (!this._pointerInputEnabled()) {
        this.activeIndex = null;
        this._dragging = false;
        return;
      }
      if (this.activeIndex != null && this.piano) {
        this.piano.stopNote(this.activeIndex);
      }
      this.activeIndex = null;
      this._dragging = false;
    },

    _onMove(ev) {
      if (!this._pointerInputEnabled()) return;
      if (!this._dragging || this.activeIndex == null) return;
      ev.preventDefault();
      const cx = ev.clientX ?? ev.touches?.[0]?.clientX;
      const cy = ev.clientY ?? ev.touches?.[0]?.clientY;
      const idx = this._pick(cx, cy);
      if (idx !== this.activeIndex) {
        this.piano.stopNote(this.activeIndex);
        this.activeIndex = idx;
        if (idx != null) this.piano.startNote(idx, null);
      }
    },

    setKeyVisual(index, down) {
      const st = this.keys[index];
      if (!st) return;
      if (down) {
        const api = this.piano && this.piano.playMode === 'api';
        st.target = api ? PHYS.pressed - 0.015 : PHYS.pressed;
        st.stiff = PHYS.stiffnessDown;
        st.damp = PHYS.dampingDown;
        st.pressed = true;
        if (api) {
          this._prepareKeyEmissive(st);
          st.apiGlowT = 1;
          this._spawnApiRipple(index);
        }
      } else {
        st.target = PHYS.rest;
        st.stiff = PHYS.stiffnessUp;
        st.damp = PHYS.dampingUp;
        st.pressed = false;
      }
    },

    _tick() {
      requestAnimationFrame(this._tick);
      if (!this.ready) return;
      const dt = 0.016;
      this.keys.forEach((st) => {
        if (!st) return;
        const x = st.angle - st.target;
        const acc = (-st.stiff * x - st.damp * st.vel) / PHYS.mass;
        st.vel += acc * dt;
        st.angle += st.vel * dt;
        st.pivot.rotation.x = st.angle;
      });
      if (this.piano && this.piano.playMode === 'api') {
        this.keys.forEach((st) => {
          if (!st || !st.mesh || !st.mesh.material) return;
          this._prepareKeyEmissive(st);
          let t = typeof st.apiGlowT === 'number' ? st.apiGlowT : 0;
          if (!st.pressed) {
            t *= 0.9;
            if (t < 0.02) t = 0;
            st.apiGlowT = t;
          }
          const g = Math.min(1, t + (st.pressed ? 0.26 : 0));
          const m = st.mesh.material;
          m.emissive.copy(st._emiColBase).lerp(st._emiHot, g * (st.isBlack ? 0.82 : 0.48));
          m.emissiveIntensity = st._emiIntBase + g * (st.isBlack ? 0.95 : 0.72);
        });
      }
      if (this._apiRipples && this._apiRipples.length) {
        const next = [];
        this._apiRipples.forEach((r) => {
          if (!r.mesh) return;
          r.age += dt;
          const u = Math.min(1, r.age / 0.38);
          const maxSc = typeof r.mesh.userData.maxScale === 'number' ? r.mesh.userData.maxScale : 1.35;
          const sc = 1 + u * (maxSc - 1);
          r.mesh.scale.set(sc, sc, sc);
          r.mesh.material.opacity = Math.max(0, 0.52 * (1 - u * u));
          if (r.age >= 0.38) {
            const p = r.mesh.parent;
            if (p) p.remove(r.mesh);
            r.mesh.geometry.dispose();
            r.mesh.material.dispose();
          } else {
            next.push(r);
          }
        });
        this._apiRipples = next;
      }
      this.renderer.render(this.scene, this.camera);
    },
    };
  }

  window.createPiano941Viewer = createPiano941Viewer;
})();
