/* InsertPress Planner — 3D view (Three.js r128, Z up like the machine).
 * Interface shared with Viewer2D:
 *   setBed(x, y, park)  setPart(positions, size)  setInstances([{rot, tx, ty}])
 *   setHoles(markers)   setPath(pts)  setPathVisible(v)  setTip(pos, kind)
 *   setXray(on)  frame(kind, bounds)  resize()
 * Handlers: onPick(info) onHover(id, cx, cy) tool() onMoveStart() onMove(dx, dy) onMoveEnd()
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  const C = {
    bed: 0x2b363c, grid: 0x36434a, grid10: 0x4a5961, fence: 0x7d888d, limit: 0x6d7c84,
    part: 0xd4d8da, edges: 0x6b757a,
    found: 0xf3f1ea, used: 0xc99a3b, active: 0xffd27a, path: 0xe8743f,
    tip: 0xb9c0c3, hot: 0xff7a3d,
  };

  class Viewer {
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers || {};
      this.bed = { x: 200, y: 200 };
      this.markerMeshes = [];
      this.instMeshes = [];
      this.labelCache = new Map();
      this.instances = [{ rot: 0, tx: 0, ty: 0 }];

      const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      el.appendChild(r.domElement);

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 6000);
      this.camera.up.set(0, 0, 1);
      this.camera.position.set(-120, -160, 160);

      const c = r.domElement;
      // Registered before OrbitControls (capture) so a part drag can switch orbiting off first.
      c.addEventListener('pointerdown', (e) => this._down(e), { capture: true });
      this.controls = new THREE.OrbitControls(this.camera, c);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.12;
      this.controls.screenSpacePanning = true;

      this.scene.add(new THREE.HemisphereLight(0xf2f4f5, 0x3a4348, 0.8));
      const sun = new THREE.DirectionalLight(0xffffff, 0.7);
      sun.position.set(-0.6, -1, 1.6);
      this.scene.add(sun);
      const rim = new THREE.DirectionalLight(0xffe2b0, 0.25);
      rim.position.set(1, 0.8, 0.6);
      this.scene.add(rim);

      this.bedGroup = new THREE.Group();
      this.partGroup = new THREE.Group();
      this.markerGroup = new THREE.Group();
      this.pathGroup = new THREE.Group();
      this.scene.add(this.bedGroup, this.partGroup, this.markerGroup, this.pathGroup);
      this._makeTip();
      this.setBed(200, 200);

      this.raycaster = new THREE.Raycaster();
      this.mouse = new THREE.Vector2();
      c.addEventListener('pointermove', (e) => this._move(e));
      c.addEventListener('pointerup', (e) => this._up(e));
      c.addEventListener('pointerleave', () => { this._hoverId = null; if (this.h.onHover) this.h.onHover(null); });

      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(el);
      this.resize();
      const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
      loop();
    }

    resize() {
      const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = w + 'px';
      this.renderer.domElement.style.height = h + 'px';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    _clear(g, keepShared) {
      while (g.children.length) {
        const o = g.children.pop();
        if (keepShared) continue;
        o.traverse((n) => {
          if (n.geometry && !n.userData.shared) n.geometry.dispose();
          if (n.material && !n.userData.sharedMat) n.material.dispose();
        });
      }
    }

    _lines(arr, color, opacity) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity != null, opacity: opacity == null ? 1 : opacity }));
    }

    setBed(x, y, park) {
      this.bed = { x, y };
      this._clear(this.bedGroup);
      const M = 30; // show a margin around the travel
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(x + M * 2, y + M * 2),
        new THREE.MeshStandardMaterial({ color: C.bed, roughness: 0.95, metalness: 0.05 }));
      plate.position.set(x / 2, y / 2, -0.06);
      this.bedGroup.add(plate);
      const minor = [], major = [];
      for (let i = 0; i <= x; i += 10) (i % 50 ? minor : major).push(i, 0, 0, i, y, 0);
      for (let j = 0; j <= y; j += 10) (j % 50 ? minor : major).push(0, j, 0, x, j, 0);
      this.bedGroup.add(this._lines(minor, C.grid), this._lines(major, C.grid10));
      // travel limit
      this.bedGroup.add(this._lines([0, 0, 0.02, x, 0, 0.02, x, 0, 0.02, x, y, 0.02, x, y, 0.02, 0, y, 0.02, 0, y, 0.02, 0, 0, 0.02], C.limit));
      // fence rails
      const mat = new THREE.MeshStandardMaterial({ color: C.fence, roughness: 0.45, metalness: 0.6 });
      const L = Math.min(Math.max(x, y), 120);
      const fx = new THREE.Mesh(new THREE.BoxGeometry(L + 4, 4, 8), mat);
      fx.position.set(L / 2 - 2, -2, 4);
      const fy = new THREE.Mesh(new THREE.BoxGeometry(4, L, 8), mat.clone());
      fy.position.set(-2, L / 2, 4);
      this.bedGroup.add(fx, fy);
      // origin axes
      const ax = this._lines([0, 0, 8.2, 14, 0, 8.2], 0xe8743f);
      const ay = this._lines([0, 0, 8.2, 0, 14, 8.2], 0x7fc1a5);
      this.bedGroup.add(ax, ay);
      if (park) {
        const p = park, s = 4;
        this.bedGroup.add(this._lines([p.x - s, p.y, 0.05, p.x + s, p.y, 0.05, p.x, p.y - s, 0.05, p.x, p.y + s, 0.05], 0xb9c3c2));
      }
    }

    setPart(positions, size) {
      this._clear(this.partGroup, true);
      if (this.geom) { this.geom.dispose(); this.geom = null; }
      if (this.edgeGeom) { this.edgeGeom.dispose(); this.edgeGeom = null; }
      this.size = size;
      this.instMeshes = [];
      if (!positions) return;
      const g = (this.geom = new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      if (positions.length / 9 < 400000) this.edgeGeom = new THREE.EdgesGeometry(g, 35);
      this.partMat = new THREE.MeshStandardMaterial({
        color: C.part, roughness: 0.7, metalness: 0.05,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      this.edgeMat = new THREE.LineBasicMaterial({ color: C.edges, transparent: true, opacity: 0.55 });
      this.setXray(this.xray);
      this.setInstances(this.instances);
    }

    setInstances(list) {
      this.instances = list && list.length ? list : [{ rot: 0, tx: 0, ty: 0 }];
      this._clear(this.partGroup, true);
      this.instMeshes = [];
      if (!this.geom) return;
      this.instances.forEach((inst, i) => {
        const m = new THREE.Mesh(this.geom, this.partMat);
        m.userData.inst = i;
        m.rotation.z = (inst.rot * Math.PI) / 180;
        m.position.set(inst.tx, inst.ty, 0);
        this.partGroup.add(m);
        this.instMeshes.push(m);
        if (this.edgeGeom) {
          const e = new THREE.LineSegments(this.edgeGeom, this.edgeMat);
          e.rotation.copy(m.rotation);
          e.position.copy(m.position);
          this.partGroup.add(e);
        }
      });
    }

    setXray(on) {
      this.xray = !!on;
      if (!this.partMat) return;
      this.partMat.transparent = this.xray;
      this.partMat.opacity = this.xray ? 0.32 : 1;
      this.partMat.depthWrite = !this.xray;
      this.partMat.needsUpdate = true;
      this.edgeMat.opacity = this.xray ? 0.9 : 0.55;
    }

    /** markers: [{key, id, x, y, H, dia, label, used, active}] in machine coordinates */
    setHoles(markers) {
      this._clear(this.markerGroup);
      this.markerMeshes = [];
      const s = this.size || { x: 60, y: 60 };
      const tag = Math.max(3.2, Math.min(8, Math.hypot(s.x, s.y) * 0.045));
      for (const h of markers) {
        const r = (h.dia || 4) / 2;
        const color = h.active ? C.active : h.used ? C.used : C.found;
        const ring = new THREE.Mesh(new THREE.RingGeometry(r + 0.25, r + (h.used ? 1.3 : 0.8), 40),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: h.used ? 1 : 0.8, side: THREE.DoubleSide, depthTest: false }));
        ring.position.set(h.x, h.y, h.H + 0.03);
        ring.renderOrder = 2;
        this.markerGroup.add(ring);
        // bore marker so the depth reads in X-ray
        if (h.depth) {
          const bore = this._lines([h.x, h.y, h.H, h.x, h.y, h.H - h.depth], color, 0.7);
          this.markerGroup.add(bore);
        }
        const hit = new THREE.Mesh(new THREE.CircleGeometry(r + 1.6, 20),
          new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        hit.position.copy(ring.position);
        hit.userData.id = h.id;
        this.markerGroup.add(hit);
        this.markerMeshes.push(hit);
        if (h.used && h.label != null) {
          const sp = new THREE.Sprite(this._labelMat(String(h.label), h.active));
          sp.userData.sharedMat = true;
          sp.userData.shared = true; // sprite geometry is shared inside Three.js
          sp.position.set(h.x, h.y, h.H + tag * 0.95);
          const wide = String(h.label).length;
          sp.scale.set(tag * (wide > 2 ? 1.7 : wide > 1 ? 1.35 : 1), tag, 1);
          sp.renderOrder = 3;
          this.markerGroup.add(sp);
        }
      }
    }

    _labelMat(text, active) {
      const key = text + (active ? '*' : '');
      if (this.labelCache.has(key)) return this.labelCache.get(key);
      const c = document.createElement('canvas');
      const w = text.length > 2 ? 210 : text.length > 1 ? 172 : 128;
      c.width = w; c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = active ? '#ffd27a' : '#c99a3b';
      const rr = 22;
      x.beginPath();
      x.moveTo(rr, 6); x.lineTo(w - rr, 6); x.quadraticCurveTo(w - 6, 6, w - 6, rr);
      x.lineTo(w - 6, 122 - rr); x.quadraticCurveTo(w - 6, 122, w - rr, 122);
      x.lineTo(rr, 122); x.quadraticCurveTo(6, 122, 6, 122 - rr);
      x.lineTo(6, rr); x.quadraticCurveTo(6, 6, rr, 6);
      x.fill();
      x.fillStyle = '#2a2418';
      x.font = '700 74px Archivo, "Helvetica Neue", Arial, sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(text, w / 2, 68);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      const m = new THREE.SpriteMaterial({ map: tex, depthTest: false });
      this.labelCache.set(key, m);
      return m;
    }

    setPath(pts) {
      this._clear(this.pathGroup);
      if (!pts || pts.length < 2) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
      const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: C.path, dashSize: 2.2, gapSize: 1.4 }));
      line.computeLineDistances();
      this.pathGroup.add(line);
    }

    setPathVisible(v) { this.pathGroup.visible = v; }

    _makeTip() {
      const g = (this.tip = new THREE.Group());
      this.tipMat = new THREE.MeshStandardMaterial({ color: C.tip, roughness: 0.35, metalness: 0.8, emissive: 0x000000 });
      const coneH = 7;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.8, coneH, 24), this.tipMat);
      cone.rotation.x = -Math.PI / 2;
      cone.position.z = coneH / 2;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 26, 24),
        new THREE.MeshStandardMaterial({ color: 0x3c474d, roughness: 0.6, metalness: 0.3 }));
      body.rotation.x = Math.PI / 2;
      body.position.z = coneH + 13;
      const glow = new THREE.Mesh(new THREE.RingGeometry(2.2, 3.4, 32),
        new THREE.MeshBasicMaterial({ color: C.hot, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthTest: false }));
      glow.renderOrder = 4;
      this.tipGlow = glow;
      g.add(cone, body, glow);
      g.visible = false;
      this.scene.add(g);
    }

    setTip(pos, kind) {
      if (!pos) { this.tip.visible = false; return; }
      this.tip.visible = true;
      this.tip.position.set(pos[0], pos[1], pos[2]);
      const hot = kind === 'press' || kind === 'dwell';
      this.tipMat.emissive.setHex(hot ? 0x8a2a08 : 0x000000);
      this.tipGlow.material.opacity = hot ? 0.85 : 0;
    }

    frame(kind, b) {
      const s = b || (this.size ? { x: 0, y: 0, w: this.size.x, h: this.size.y, z: this.size.z } : { x: 0, y: 0, w: this.bed.x, h: this.bed.y, z: 10 });
      const c = new THREE.Vector3(s.x + s.w / 2, s.y + s.h / 2, (s.z || 10) / 2);
      const d = Math.max(s.w, s.h, s.z || 10, 30) * 2.3;
      if (kind === 'top') this.camera.position.set(c.x, c.y - d * 0.001, c.z + d * 1.15);
      else if (kind === 'front') this.camera.position.set(c.x, c.y - d * 1.2, c.z + d * 0.22);
      else this.camera.position.set(c.x - d * 0.68, c.y - d * 0.95, c.z + d * 0.85);
      this.controls.target.copy(c);
      this.controls.update();
    }

    _ray(e) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.mouse, this.camera);
    }

    _tool() { return this.h.tool ? this.h.tool() : 'select'; }

    _down(e) {
      this._press = { x: e.clientX, y: e.clientY, button: e.button };
      if (e.button !== 0 || this._tool() !== 'move' || !this.instMeshes.length) return;
      this._ray(e);
      const hit = this.raycaster.intersectObjects(this.instMeshes, false)[0];
      if (!hit) return;
      this.controls.enabled = false;
      this._drag = { plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.point.z), start: hit.point.clone() };
      this.renderer.domElement.setPointerCapture(e.pointerId);
      if (this.h.onMoveStart) this.h.onMoveStart();
    }

    _move(e) {
      if (this._drag) {
        this._ray(e);
        const p = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this._drag.plane, p) && this.h.onMove) {
          this.h.onMove(p.x - this._drag.start.x, p.y - this._drag.start.y);
        }
        return;
      }
      if (e.buttons) return;
      this._ray(e);
      const m = this.raycaster.intersectObjects(this.markerMeshes, false)[0];
      const id = m ? m.object.userData.id : null;
      const tool = this._tool();
      let cursor = '';
      if (tool === 'move') cursor = this.raycaster.intersectObjects(this.instMeshes, false).length ? 'move' : '';
      else if (id != null) cursor = 'pointer';
      else if (tool === 'place') cursor = 'crosshair';
      this.renderer.domElement.style.cursor = cursor;
      this._hoverId = id;
      if (this.h.onHover) this.h.onHover(tool === 'move' ? null : id, e.clientX, e.clientY);
    }

    _up(e) {
      if (this._drag) {
        this._drag = null;
        this.controls.enabled = true;
        if (this.h.onMoveEnd) this.h.onMoveEnd();
        this._press = null;
        return;
      }
      const p = this._press;
      this._press = null;
      if (!p || p.button !== 0) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
      if (this._tool() === 'move') return;
      this._ray(e);
      const m = this.raycaster.intersectObjects(this.markerMeshes, false)[0];
      if (m) return this.h.onPick && this.h.onPick({ type: 'hole', id: m.object.userData.id });
      const hit = this.raycaster.intersectObjects(this.instMeshes, false)[0];
      if (hit && this.h.onPick) {
        this.h.onPick({ type: 'surface', inst: hit.object.userData.inst, point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
          normalZ: hit.face ? hit.face.normal.z : 0 });
      }
    }
  }

  IP.Viewer = Viewer;
})(typeof window !== 'undefined' ? window : globalThis);
