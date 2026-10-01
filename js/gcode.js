/* InsertPress Planner — G-code for GRBL 1.1, plus a motion timeline for preview.
 *
 * Coordinate convention (set up once per session on the machine):
 *   X0 Y0  = inside corner of the fence
 *   Z0     = tip touching the bed with the spring float relaxed (paper test)
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  // Typical tapered brass inserts (CNC Kitchen-style sizes). Edit to match yours.
  // L = length, hole = recommended hole diameter, od = outside diameter of the knurl.
  const INSERTS = {
    m2:  { name: 'M2',       L: 3.0, hole: 3.2, od: 3.6 },
    m25: { name: 'M2.5',     L: 4.0, hole: 3.6, od: 4.6 },
    m3:  { name: 'M3',       L: 5.7, hole: 4.0, od: 5.0 },
    m3s: { name: 'M3 short', L: 3.0, hole: 4.0, od: 5.0 },
    m4:  { name: 'M4',       L: 8.1, hole: 5.6, od: 6.3 },
    m5:  { name: 'M5',       L: 9.5, hole: 6.4, od: 7.1 },
  };

  // Starting points for press settings by plastic. Tune on test prints.
  const MATERIALS = {
    pla:  { name: 'PLA',   tipTemp: 215, pressFeed: 60, dwell: 2.0 },
    petg: { name: 'PETG',  tipTemp: 235, pressFeed: 45, dwell: 3.0 },
    abs:  { name: 'ABS',   tipTemp: 245, pressFeed: 50, dwell: 2.5 },
    asa:  { name: 'ASA',   tipTemp: 250, pressFeed: 50, dwell: 2.5 },
    pa:   { name: 'Nylon', tipTemp: 260, pressFeed: 40, dwell: 3.0 },
    pc:   { name: 'PC',    tipTemp: 280, pressFeed: 35, dwell: 3.5 },
  };

  const DEFAULT_SETTINGS = {
    mode: 'xy',            // 'xy' moves X/Y; 'manual' pauses so you position the part
    loadMode: 'each',      // 'each' pause per hole; 'start' load every insert first
    overloadStop: true,    // press with G38.3 so the move halts if the float sensor trips
    defaultInsert: 'm3',
    material: 'pla',
    tipTemp: 215,          // °C, written into the job so you set the iron to match
    sink: 0.1,             // mm below the surface to finish the insert
    approachGap: 1.0,      // mm above the insert top before slowing to press feed
    pressFeed: 60,         // mm/min
    dwell: 2.0,            // s, hold at depth
    retractSlow: 2.0,      // mm, slow lift distance off the insert
    retractFeed: 120,      // mm/min
    clearance: 5.0,        // mm above (part top + longest insert) for travel
    minClear: 0,           // mm, never travel lower than this
    bedX: 200, bedY: 200,  // usable travel from the fence corner
    park: true, parkX: 0, parkY: 0,
    rapidXY: 1500, rapidZ: 400, // mm/min, used for time estimates and preview
    loadTime: 4,           // s per hand-loaded insert, for the time estimate
    insertCost: 0.08,      // $ per insert, for the parts list
    wallMin: 1.0,          // mm of plastic wanted outside the knurl
    dMin: 2.5, dMax: 7.0,  // hole-detection diameter range
  };

  function guessInsert(dia, fallback) {
    if (!dia) return fallback;
    let best = null, bd = Infinity;
    for (const [k, v] of Object.entries(INSERTS)) {
      const d = Math.abs(v.hole - dia);
      if (d < bd - 1e-9) { bd = d; best = k; }
    }
    if (best && INSERTS[fallback] && INSERTS[fallback].hole === INSERTS[best].hole) return fallback;
    return bd <= 0.6 ? best : fallback;
  }

  function fmt(v) {
    const t = (Math.round(v * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return t === '-0' ? '0' : t;
  }

  const labelOf = (h, i) => (h.label != null ? h.label : String(i + 1));

  /** Per-hole sanity checks. holes are in press order. */
  function check(holes, s) {
    const out = [];
    const seenLocal = new Set();
    holes.forEach((h, i) => {
      const n = labelOf(h, i);
      const ins = INSERTS[h.insert] || INSERTS[s.defaultInsert];
      // geometry checks only once per source hole, not for every copy
      const lk = h.localId != null ? h.localId : 'i' + i;
      if (!seenLocal.has(lk)) {
        seenLocal.add(lk);
        if (h.blind && h.depth != null && h.depth < ins.L + 0.3) {
          out.push({ level: 'warn', hole: n, localId: h.localId, text: `Hole ${n} is ${fmt(h.depth)} mm deep but the ${ins.name} insert is ${fmt(ins.L)} mm long. It will bottom out.` });
        }
        if (h.dia && Math.abs(h.dia - ins.hole) > 0.4) {
          out.push({ level: 'warn', hole: n, localId: h.localId, text: `Hole ${n} measures ${fmt(h.dia)} mm; ${ins.name} inserts usually want about ${fmt(ins.hole)} mm.` });
        }
        if (h.wall != null && h.dia) {
          const need = (ins.od - h.dia) / 2 + s.wallMin;
          if (h.wall < need) {
            out.push({ level: 'warn', hole: n, localId: h.localId, text: `Hole ${n} has ${fmt(h.wall)} mm of wall. An ${ins.name} insert wants about ${fmt(need)} mm, so the side may bulge or crack.` });
          }
        }
      }
      if (s.mode === 'xy' && (h.x < 0 || h.y < 0 || h.x > s.bedX || h.y > s.bedY)) {
        out.push({ level: 'error', hole: n, localId: h.localId, text: `Hole ${n} (X${fmt(h.x)} Y${fmt(h.y)}) is outside the ${s.bedX} × ${s.bedY} mm travel.` });
      }
      const sink = h.sink != null ? h.sink : s.sink;
      if (h.H - sink < 0) {
        out.push({ level: 'error', hole: n, localId: h.localId, text: `Hole ${n} would drive the tip below the bed.` });
      }
    });
    for (let i = 0; i < holes.length; i++) {
      for (let j = 0; j < i; j++) {
        if (Math.hypot(holes[j].x - holes[i].x, holes[j].y - holes[i].y) < 1) {
          out.push({ level: 'warn', hole: labelOf(holes[i], i), localId: holes[i].localId,
            text: `Holes ${labelOf(holes[j], j)} and ${labelOf(holes[i], i)} are less than 1 mm apart. Copies may overlap, or one is a duplicate.` });
        }
      }
    }
    return out;
  }

  /**
   * job = { name, partTop, holes:[{x,y,H,insert,sink?,dia?,depth?,blind?,wall?,label?,copy?,localId?}], settings }
   * holes must be in press order and in machine coordinates.
   * Returns { text, issues, seconds, clearZ, moves, stats }.
   */
  function generate(job) {
    const s = Object.assign({}, DEFAULT_SETTINGS, job.settings || {});
    const holes = job.holes || [];
    const issues = check(holes, s);
    const empty = { text: '', issues, seconds: 0, clearZ: 0, moves: [], stats: null };
    if (!holes.length) return empty;

    const ins = (h) => INSERTS[h.insert] || INSERTS[s.defaultInsert];
    const maxL = Math.max(...holes.map((h) => ins(h).L));
    const top = job.partTop != null ? job.partTop : Math.max(...holes.map((h) => h.H));
    const clearZ = Math.max(s.minClear, top + maxL + s.clearance);
    const xy = s.mode === 'xy';
    const mat = MATERIALS[s.material] || MATERIALS.pla;
    const out = [];
    const moves = [];
    const T = { travel: 0, rapidZ: 0, press: 0, dwell: 0, lift: 0, load: 0 };
    let dist = 0;
    let t = 0;
    let pos = [xy && s.park ? s.parkX : holes[0].x, xy && s.park ? s.parkY : holes[0].y, clearZ];
    const push = (l) => { out.push(l); return out.length - 1; };
    const move = (kind, to, feed, line, hole, bucket) => {
      const d = Math.hypot(to[0] - pos[0], to[1] - pos[1], to[2] - pos[2]);
      const dur = feed ? (d / feed) * 60 : 0;
      moves.push({ kind, from: pos.slice(), to: to.slice(), t0: t, t1: t + dur, line, hole });
      t += dur; T[bucket] += dur;
      if (kind === 'travel') dist += Math.hypot(to[0] - pos[0], to[1] - pos[1]);
      pos = to.slice();
    };
    const wait = (kind, secs, line, hole, bucket) => {
      moves.push({ kind, from: pos.slice(), to: pos.slice(), t0: t, t1: t + secs, line, hole });
      t += secs; T[bucket] += secs;
    };

    push(`; InsertPress Planner job: ${job.name || 'untitled'}`);
    push(`; ${holes.length} insert${holes.length === 1 ? '' : 's'}${job.copies > 1 ? ` across ${job.copies} copies` : ''}`);
    push(`; Material ${mat.name}, iron at ${fmt(s.tipTemp)} C`);
    push(`; Mode: ${xy ? 'X/Y motion' : 'Z only, part positioned by hand'}`);
    push('; Origin: X0 Y0 = fence corner, Z0 = bed surface (touch-off)');
    push(`; Clear Z${fmt(clearZ)}, press F${fmt(s.pressFeed)}, dwell ${fmt(s.dwell)} s`);
    push('G21 G90 G94 G17');
    push('G54');
    let l = push(`G0 Z${fmt(clearZ)}`);
    move('rapid', [pos[0], pos[1], clearZ], s.rapidZ, l, null, 'rapidZ');
    push(`(MSG,Set iron to ${fmt(s.tipTemp)}C then Cycle Start)`);
    l = push('M0');
    wait('pause', 1.5, l, null, 'load');
    if (s.loadMode === 'start') {
      push(`(MSG,Place all ${holes.length} inserts then Cycle Start)`);
      l = push('M0');
      wait('pause', s.loadTime * holes.length, l, null, 'load');
    }

    holes.forEach((h, i) => {
      const n = labelOf(h, i);
      const k = ins(h);
      const sink = h.sink != null ? h.sink : s.sink;
      const zAbove = h.H + k.L + s.approachGap;
      const zFinal = h.H - sink;
      const zLift = Math.min(zFinal + s.retractSlow, clearZ);
      const where = h.copy != null && job.copies > 1 ? ` copy ${h.copy + 1}` : '';
      push('');
      push(`; Hole ${n}/${holes.length}${where}  X${fmt(h.x)} Y${fmt(h.y)} Z${fmt(h.H)} ${k.name}`);
      if (xy) {
        l = push(`G0 X${fmt(h.x)} Y${fmt(h.y)}`);
        move('travel', [h.x, h.y, clearZ], s.rapidXY, l, n, 'travel');
        if (s.loadMode === 'each') {
          push(`(MSG,Hole ${n}: place ${k.name} insert)`);
          l = push('M0');
          wait('pause', s.loadTime, l, n, 'load');
        }
      } else {
        const what = s.loadMode === 'each' ? `place ${k.name}, ` : '';
        push(`(MSG,Hole ${n}: ${what}align X${fmt(h.x)} Y${fmt(h.y)})`);
        l = push('M0');
        pos = [h.x, h.y, pos[2]]; // the part moves, not the tip
        wait('pause', s.loadMode === 'each' ? s.loadTime + 3 : 3, l, n, 'load');
      }
      if (zAbove < clearZ) {
        l = push(`G0 Z${fmt(zAbove)}`);
        move('rapid', [h.x, h.y, zAbove], s.rapidZ, l, n, 'rapidZ');
      }
      l = push(s.overloadStop
        ? `G38.3 Z${fmt(zFinal)} F${fmt(s.pressFeed)} ; press, halts if float trips`
        : `G1 Z${fmt(zFinal)} F${fmt(s.pressFeed)} ; press`);
      move('press', [h.x, h.y, zFinal], s.pressFeed, l, n, 'press');
      l = push(`G4 P${fmt(s.dwell)}`);
      wait('dwell', s.dwell, l, n, 'dwell');
      l = push(`G1 Z${fmt(zLift)} F${fmt(s.retractFeed)}`);
      move('lift', [h.x, h.y, zLift], s.retractFeed, l, n, 'lift');
      l = push(`G0 Z${fmt(clearZ)}`);
      move('rapid', [h.x, h.y, clearZ], s.rapidZ, l, n, 'rapidZ');
    });

    push('');
    push('; Done');
    l = push(`G0 Z${fmt(clearZ)}`);
    if (xy && s.park) {
      l = push(`G0 X${fmt(s.parkX)} Y${fmt(s.parkY)}`);
      move('travel', [s.parkX, s.parkY, clearZ], s.rapidXY, l, null, 'travel');
    }
    push('M2');

    const bom = {};
    for (const h of holes) { const k = ins(h); bom[k.name] = (bom[k.name] || 0) + 1; }
    const stats = {
      inserts: holes.length,
      bom,
      cost: holes.length * s.insertCost,
      travelDist: dist,
      time: T,
      machineSeconds: T.travel + T.rapidZ + T.press + T.dwell + T.lift,
      lines: out.length,
    };
    return { text: out.join('\n') + '\n', issues, seconds: t, clearZ, moves, stats };
  }

  /** Tip position at time t from a moves list. */
  function sample(moves, t) {
    if (!moves.length) return null;
    let lo = 0, hi = moves.length - 1;
    if (t <= moves[0].t0) return { pos: moves[0].from, move: moves[0], index: 0 };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (moves[mid].t0 <= t) lo = mid; else hi = mid - 1;
    }
    const m = moves[lo];
    const span = m.t1 - m.t0;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - m.t0) / span)) : 1;
    return {
      pos: [m.from[0] + (m.to[0] - m.from[0]) * f, m.from[1] + (m.to[1] - m.from[1]) * f, m.from[2] + (m.to[2] - m.from[2]) * f],
      move: m, index: lo,
    };
  }

  /** Nearest-neighbour tour from (sx, sy), then 2-opt cleanup. Returns a new array. */
  function optimizeOrder(points, sx, sy) {
    const left = points.slice();
    const tour = [];
    let cx = sx, cy = sy;
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((p, i) => { const d = Math.hypot(p.x - cx, p.y - cy); if (d < bd) { bd = d; bi = i; } });
      const p = left.splice(bi, 1)[0];
      tour.push(p); cx = p.x; cy = p.y;
    }
    const start = { x: sx, y: sy };
    const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (let i = 0; i < tour.length - 1 && !improved; i++) {
        const a = i === 0 ? start : tour[i - 1], b = tour[i];
        for (let j = i + 1; j < tour.length; j++) {
          const c = tour[j], d = tour[j + 1];
          const before = D(a, b) + (d ? D(c, d) : 0);
          const after = D(a, c) + (d ? D(b, d) : 0);
          if (after < before - 1e-9) {
            const seg = tour.slice(i, j + 1).reverse();
            tour.splice(i, seg.length, ...seg);
            improved = true;
            break;
          }
        }
      }
    }
    return tour;
  }

  IP.INSERTS = INSERTS;
  IP.MATERIALS = MATERIALS;
  IP.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  IP.gcode = { generate, check, guessInsert, optimizeOrder, sample, fmt };
})(typeof window !== 'undefined' ? window : globalThis);
