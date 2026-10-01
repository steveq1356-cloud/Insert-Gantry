/* InsertPress Planner — 2D top view.
 * Used when Three.js can't load (offline, blocked CDN). Same interface as IP.Viewer.
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  class Viewer2D {
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers || {};
      this.bed = { x: 200, y: 200 };
      this.markers = [];
      this.instances = [{ rot: 0, tx: 0, ty: 0 }];
      this.path = null;
      this.pathVisible = true;
      this.tip = null;
      this.view = { k: 2, ox: 60, oy: 400 };
      this.dpr = 1;
      const c = (this.canvas = document.createElement('canvas'));
      c.style.display = 'block';
      c.style.touchAction = 'none';
      el.appendChild(c);
      this.ctx = c.getContext('2d');

      let drag = null;
      c.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        const { px, py } = this._local(e);
        const tool = this._tool();
        if (e.button === 0 && tool === 'move' && this._instAt(px, py) != null) {
          drag = { kind: 'part', wx: this.wx(px), wy: this.wy(py) };
          if (this.h.onMoveStart) this.h.onMoveStart();
        } else {
          drag = { kind: 'pan', x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: 0, button: e.button };
        }
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointermove', (e) => {
        if (drag && drag.kind === 'part') {
          const { px, py } = this._local(e);
          if (this.h.onMove) this.h.onMove(this.wx(px) - drag.wx, this.wy(py) - drag.wy);
          return;
        }
        if (drag) {
          drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x, e.clientY - drag.y));
          if (drag.moved > 4) {
            this.view.ox = drag.ox + (e.clientX - drag.x);
            this.view.oy = drag.oy + (e.clientY - drag.y);
            this._userView = true;
            this.draw();
          }
          return;
        }
        this._hover(e);
      });
      c.addEventListener('pointerup', (e) => {
        if (drag && drag.kind === 'part') { if (this.h.onMoveEnd) this.h.onMoveEnd(); }
        else if (drag && drag.moved <= 4 && drag.button === 0) this._pick(e);
        drag = null;
      });
      c.addEventListener('pointerleave', () => { if (this.h.onHover) this.h.onHover(null); });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { px, py } = this._local(e);
        const k = Math.min(80, Math.max(0.3, this.view.k * Math.exp(-e.deltaY * 0.0015)));
        const real = k / this.view.k;
        this.view.ox = px - (px - this.view.ox) * real;
        this.view.oy = py - (py - this.view.oy) * real;
        this.view.k = k;
        this._userView = true;
        this.draw();
      }, { passive: false });

      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(el);
      this.resize();
    }

    _tool() { return this.h.tool ? this.h.tool() : 'select'; }

    resize() {
      const dpr = (this.dpr = Math.min(window.devicePixelRatio || 1, 2));
      this.w = this.el.clientWidth || 1;
      this.hgt = this.el.clientHeight || 1;
      this.canvas.width = this.w * dpr;
      this.canvas.height = this.hgt * dpr;
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.hgt + 'px';
      this.frame(null, this._bounds);
    }

    setBed(x, y, park) { this.bed = { x, y }; this.park = park || null; this.draw(); }

    setPart(positions, size) {
      this.size = size;
      this.tris = positions;
      this.up = [];
      this.runs = [];
      if (positions) {
        const P = positions, n = P.length / 9;
        for (let t = 0; t < n; t++) {
          const b = t * 9;
          const ux = P[b + 3] - P[b], uy = P[b + 4] - P[b + 1], uz = P[b + 5] - P[b + 2];
          const vx = P[b + 6] - P[b], vy = P[b + 7] - P[b + 1], vz = P[b + 8] - P[b + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz);
          if (!l || nz / l < 0.3) continue;
          this.up.push({ b, z: (P[b + 2] + P[b + 5] + P[b + 8]) / 3, nz: nz / l });
        }
        this.up.sort((a, b) => a.z - b.z);
        // runs of equal shade share one Path2D (local coordinates), so drawing is fast and seamless
        const zt = Math.max(size.z, 0.001);
        let cur = null;
        for (const t of this.up) {
          const v = 150 + Math.round(70 * (t.z / zt)) - Math.round((1 - t.nz) * 50);
          const col = `rgb(${v},${v + 4},${v + 6})`;
          if (!cur || cur.col !== col) { cur = { col, path: new Path2D() }; this.runs.push(cur); }
          const b = t.b;
          cur.path.moveTo(P[b], P[b + 1]);
          cur.path.lineTo(P[b + 3], P[b + 4]);
          cur.path.lineTo(P[b + 6], P[b + 7]);
          cur.path.closePath();
        }
      }
      this._userView = false;
      this.draw();
    }

    setInstances(list) { this.instances = list && list.length ? list : [{ rot: 0, tx: 0, ty: 0 }]; this.draw(); }
    setHoles(markers) { this.markers = markers; this.draw(); }
    setPath(pts) { this.path = pts; this.draw(); }
    setPathVisible(v) { this.pathVisible = v; this.draw(); }
    setTip(pos, kind) { this.tip = pos ? { pos, kind } : null; this.draw(); }
    setXray() {}

    frame(kind, b) {
      if (b) this._bounds = b;
      const s = this._bounds || (this.size ? { x: 0, y: 0, w: this.size.x, h: this.size.y } : { x: 0, y: 0, w: this.bed.x, h: this.bed.y });
      const x0 = Math.min(s.x, 0) - 10, y0 = Math.min(s.y, 0) - 10;
      const x1 = Math.max(s.x + s.w, 20) + 8, y1 = Math.max(s.y + s.h, 20) + 8;
      const padX = 70, padTop = 70, padBot = 128; // room for the timeline
      const k = Math.min((this.w - padX * 2) / (x1 - x0), (this.hgt - padTop - padBot) / (y1 - y0));
      this.view.k = Math.max(0.3, Math.min(40, k));
      this.view.ox = (this.w - (x1 - x0) * this.view.k) / 2 - x0 * this.view.k;
      this.view.oy = padTop + ((this.hgt - padTop - padBot) + (y1 - y0) * this.view.k) / 2 + y0 * this.view.k;
      this.draw();
    }

    sx(x) { return this.view.ox + x * this.view.k; }
    sy(y) { return this.view.oy - y * this.view.k; }
    wx(px) { return (px - this.view.ox) / this.view.k; }
    wy(py) { return (this.view.oy - py) / this.view.k; }

    _screen() { const d = this.dpr; this.ctx.setTransform(d, 0, 0, d, 0, 0); }

    draw() {
      const c = this.ctx;
      if (!c || !this.w) return;
      this._screen();
      c.clearRect(0, 0, this.w, this.hgt);
      const k = this.view.k;

      // bed and grid
      c.fillStyle = 'rgba(255,255,255,0.025)';
      c.fillRect(this.sx(0), this.sy(this.bed.y), this.bed.x * k, this.bed.y * k);
      const step = k > 5 ? 5 : 10;
      c.lineWidth = 1;
      for (let i = 0; i <= this.bed.x; i += step) {
        c.strokeStyle = i % 50 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.045)';
        const X = Math.round(this.sx(i)) + 0.5;
        c.beginPath(); c.moveTo(X, this.sy(0)); c.lineTo(X, this.sy(this.bed.y)); c.stroke();
      }
      for (let j = 0; j <= this.bed.y; j += step) {
        c.strokeStyle = j % 50 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.045)';
        const Y = Math.round(this.sy(j)) + 0.5;
        c.beginPath(); c.moveTo(this.sx(0), Y); c.lineTo(this.sx(this.bed.x), Y); c.stroke();
      }
      c.strokeStyle = 'rgba(160,178,186,0.55)';
      c.setLineDash([6, 5]);
      c.strokeRect(this.sx(0) + 0.5, this.sy(this.bed.y) + 0.5, this.bed.x * k, this.bed.y * k);
      c.setLineDash([]);
      // ruler numbers along the fence
      c.fillStyle = 'rgba(200,210,212,0.55)';
      c.font = '11px "JetBrains Mono", Menlo, monospace';
      c.textAlign = 'center'; c.textBaseline = 'top';
      const lab = k > 3 ? 10 : k > 1.2 ? 50 : 100;
      for (let i = lab; i <= this.bed.x; i += lab) c.fillText(String(i), this.sx(i), this.sy(0) + 16);
      c.textAlign = 'right'; c.textBaseline = 'middle';
      for (let j = lab; j <= this.bed.y; j += lab) c.fillText(String(j), this.sx(0) - 16, this.sy(j));

      // fence
      c.fillStyle = '#7d888d';
      const fw = Math.max(5, Math.min(12, 3 * k));
      const fl = Math.min(Math.max(this.bed.x, this.bed.y), 120);
      c.fillRect(this.sx(0) - fw, this.sy(fl), fw, fl * k + fw);
      c.fillRect(this.sx(0) - fw, this.sy(0), fl * k + fw, fw);
      // origin axes
      c.lineWidth = 2;
      c.strokeStyle = '#e8743f'; c.beginPath(); c.moveTo(this.sx(0), this.sy(0)); c.lineTo(this.sx(0) + 26, this.sy(0)); c.stroke();
      c.strokeStyle = '#7fc1a5'; c.beginPath(); c.moveTo(this.sx(0), this.sy(0)); c.lineTo(this.sx(0), this.sy(0) - 26); c.stroke();
      if (this.park) {
        const X = this.sx(this.park.x), Y = this.sy(this.park.y);
        c.strokeStyle = '#b9c3c2'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(X - 6, Y); c.lineTo(X + 6, Y); c.moveTo(X, Y - 6); c.lineTo(X, Y + 6); c.stroke();
      }

      // parts
      if (this.runs && this.runs.length) {
        const d = this.dpr;
        for (const inst of this.instances) {
          const a = (inst.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
          c.setTransform(d * k * co, -d * k * si, -d * k * si, -d * k * co, d * (this.view.ox + k * inst.tx), d * (this.view.oy - k * inst.ty));
          c.lineWidth = 0.8 / k;
          c.lineJoin = 'round';
          for (const r of this.runs) {
            c.fillStyle = r.col; c.strokeStyle = r.col;
            c.fill(r.path); c.stroke(r.path);
          }
        }
        this._screen();
      }

      // path
      if (this.path && this.pathVisible && this.path.length > 1) {
        c.save();
        c.strokeStyle = '#e8743f'; c.lineWidth = 1.6; c.setLineDash([6, 4]);
        c.beginPath();
        let last = null;
        for (const p of this.path) {
          if (last && last[0] === p[0] && last[1] === p[1]) continue;
          if (!last) c.moveTo(this.sx(p[0]), this.sy(p[1])); else c.lineTo(this.sx(p[0]), this.sy(p[1]));
          last = p;
        }
        c.stroke();
        c.restore();
      }

      // holes
      c.font = '700 11.5px Archivo, "Helvetica Neue", Arial, sans-serif';
      for (const h of this.markers) {
        const r = Math.max(4, ((h.dia || 4) / 2) * k);
        const x = this.sx(h.x), y = this.sy(h.y);
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
        if (h.used) {
          c.fillStyle = h.active ? 'rgba(255,210,122,.4)' : 'rgba(201,154,59,.3)'; c.fill();
          c.lineWidth = 2.5; c.strokeStyle = h.active ? '#ffd27a' : '#c99a3b'; c.stroke();
        } else {
          c.fillStyle = h.active ? 'rgba(201,154,59,.25)' : 'rgba(31,40,45,.16)'; c.fill();
          c.lineWidth = 3.5; c.strokeStyle = 'rgba(255,255,255,.85)'; c.stroke();
          c.lineWidth = 1.6; c.strokeStyle = h.active ? '#8a6420' : '#1f282d'; c.setLineDash([4, 3]); c.stroke(); c.setLineDash([]);
        }
        if (h.used && h.label != null && k > 2.4) {
          const label = String(h.label);
          const tw = Math.max(20, c.measureText(label).width + 10);
          const tx = x + r * 0.7, ty = y - r * 0.7 - 18;
          c.fillStyle = h.active ? '#ffd27a' : '#c99a3b';
          roundRect(c, tx, ty, tw, 18, 4); c.fill();
          c.fillStyle = '#2a2418'; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(label, tx + tw / 2, ty + 9.5);
        }
      }

      // tip
      if (this.tip) {
        const [tx, ty] = this.tip.pos;
        const X = this.sx(tx), Y = this.sy(ty);
        const hot = this.tip.kind === 'press' || this.tip.kind === 'dwell';
        const R = Math.max(7, 3.2 * k);
        c.beginPath(); c.arc(X, Y, R, 0, Math.PI * 2);
        c.fillStyle = hot ? 'rgba(255,122,61,.35)' : 'rgba(185,192,195,.25)'; c.fill();
        c.lineWidth = 2; c.strokeStyle = hot ? '#ff7a3d' : '#e9ecea'; c.stroke();
        c.beginPath(); c.moveTo(X - R - 6, Y); c.lineTo(X + R + 6, Y); c.moveTo(X, Y - R - 6); c.lineTo(X, Y + R + 6);
        c.lineWidth = 1; c.stroke();
      }
    }

    _local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    }

    _holeAt(px, py) {
      let best = null, bd = Infinity;
      for (const h of this.markers) {
        const d = Math.hypot(this.sx(h.x) - px, this.sy(h.y) - py);
        const r = Math.max(8, ((h.dia || 4) / 2) * this.view.k + 4);
        if (d < r && d < bd) { bd = d; best = h; }
      }
      return best;
    }

    /** Highest up-facing surface under a screen point: { inst, z, nz } or null. */
    _surfaceAt(px, py) {
      if (!this.tris) return null;
      const wx = this.wx(px), wy = this.wy(py), P = this.tris;
      let hit = null;
      this.instances.forEach((inst, i) => {
        const a = (inst.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
        const dx = wx - inst.tx, dy = wy - inst.ty;
        const x = co * dx + si * dy, y = -si * dx + co * dy;
        if (x < -1 || y < -1 || x > this.size.x + 1 || y > this.size.y + 1) return;
        for (let j = this.up.length - 1; j >= 0; j--) {
          const t = this.up[j], b = t.b;
          if (hit && hit.z >= t.z + 1) break;
          const x0 = P[b], y0 = P[b + 1], x1 = P[b + 3], y1 = P[b + 4], x2 = P[b + 6], y2 = P[b + 7];
          const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
          if (!d) continue;
          const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
          const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const z = l0 * P[b + 2] + l1 * P[b + 5] + l2 * P[b + 8];
          if (!hit || z > hit.z) hit = { inst: i, z, nz: t.nz };
          break;
        }
      });
      return hit;
    }

    _instAt(px, py) { const s = this._surfaceAt(px, py); return s ? s.inst : null; }

    _pick(e) {
      const { px, py } = this._local(e);
      if (this._tool() === 'move') return;
      const h = this._holeAt(px, py);
      if (h) return this.h.onPick && this.h.onPick({ type: 'hole', id: h.id });
      const s = this._surfaceAt(px, py);
      if (s && this.h.onPick) this.h.onPick({ type: 'surface', inst: s.inst, point: { x: this.wx(px), y: this.wy(py), z: s.z }, normalZ: s.nz });
    }

    _hover(e) {
      const { px, py } = this._local(e);
      const tool = this._tool();
      if (tool === 'move') {
        this.canvas.style.cursor = this._instAt(px, py) != null ? 'move' : 'grab';
        if (this.h.onHover) this.h.onHover(null);
        return;
      }
      const h = this._holeAt(px, py);
      const id = h ? h.id : null;
      this.canvas.style.cursor = id != null ? 'pointer' : tool === 'place' ? 'crosshair' : 'grab';
      if (this.h.onHover) this.h.onHover(id, e.clientX, e.clientY);
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  IP.Viewer2D = Viewer2D;
})(typeof window !== 'undefined' ? window : globalThis);
