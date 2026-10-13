// Sketch mode: drawing tools, snapping and inference on a sketch plane.
import * as THREE from 'three';
import { toWorld, toPlane, sample, arcFrom3, arcEnds, arcMid, dist, sweep, polar } from '../kernel/sketch2d.js';
import { sketchObject, updateDashes } from './scenery.js';

let uid = 0;
export const newId = (p = 'e') => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

export class Sketcher {
  constructor(viewer, ui) {
    this.viewer = viewer; this.ui = ui;
    this.active = false;
    this.group = new THREE.Group();
    viewer.scene.add(this.group);
  }

  start(feature, plane) {
    this.active = true;
    this.feature = feature;
    this.entities = JSON.parse(JSON.stringify(feature.entities || []));
    this.plane = plane;
    this.tool = 'line';
    this.construction = false;
    this.selected = new Set();
    this.hover = null;
    this.reset();
    this.history = [JSON.stringify(this.entities)];
    this.redraw();
  }
  stop() {
    this.active = false;
    clearGroup(this.group);
    this.viewer.render();
  }
  reset() { this.pts = []; this.cursor = null; this.snap = null; this.typed = ''; this.chainStart = null; this.moving = null; }
  setTool(t) { this.tool = t; this.reset(); this.ui.sketchStatus(); this.redraw(); }
  record() { this.history.push(JSON.stringify(this.entities)); if (this.history.length > 100) this.history.shift(); this.ui.sketchChanged(); }
  undo() {
    if (this.history.length < 2) return;
    this.history.pop();
    this.entities = JSON.parse(this.history[this.history.length - 1]);
    this.selected.clear(); this.reset(); this.redraw(); this.ui.sketchChanged();
  }

  // ------------------------------------------------------------ geometry helpers
  toSketch(sx, sy) {
    const ray = this.viewer.screenToRay(sx, sy).ray;
    const n = new THREE.Vector3(...this.plane.normal), o = new THREE.Vector3(...this.plane.origin);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    const w = ray.origin.clone().addScaledVector(ray.direction, t);
    return toPlane(this.plane, [w.x, w.y, w.z]);
  }
  tol() { return this.viewer.pixelSize() * 9; }
  snapPoints() {
    const out = [{ p: [0, 0], kind: 'origin' }];
    for (const e of this.entities) {
      if (e.type === 'line') out.push({ p: e.a, kind: 'end' }, { p: e.b, kind: 'end' }, { p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], kind: 'mid' });
      else if (e.type === 'arc') { const [s, t] = arcEnds(e); out.push({ p: s, kind: 'end' }, { p: t, kind: 'end' }, { p: e.c, kind: 'center' }, { p: arcMid(e), kind: 'mid' }); }
      else if (e.type === 'circle') { out.push({ p: e.c, kind: 'center' }); for (let q = 0; q < 4; q++) out.push({ p: polar(e.c, q * Math.PI / 2, e.r), kind: 'quadrant' }); }
      else if (e.type === 'point') out.push({ p: e.p, kind: 'point' });
    }
    return out;
  }
  // snapped cursor point with inference hints
  resolve(raw) {
    const tol = this.tol();
    let best = null, bd = tol;
    for (const s of this.snapPoints()) { const d = dist(s.p, raw); if (d < bd) { bd = d; best = s; } }
    if (best) return { p: best.p.slice(), hint: best.kind };
    let p = raw.slice(), hint = null;
    const base = this.pts[this.pts.length - 1];
    if (base && (this.tool === 'line')) {
      const dx = p[0] - base[0], dy = p[1] - base[1];
      if (Math.abs(dy) < tol * 0.8 && Math.abs(dx) > tol) { p[1] = base[1]; hint = 'horizontal'; }
      else if (Math.abs(dx) < tol * 0.8 && Math.abs(dy) > tol) { p[0] = base[0]; hint = 'vertical'; }
    }
    // align with existing points horizontally / vertically
    if (!hint) {
      for (const s of this.snapPoints()) {
        if (Math.abs(s.p[0] - p[0]) < tol * 0.6) { p[0] = s.p[0]; hint = 'aligned'; break; }
      }
      for (const s of this.snapPoints()) {
        if (Math.abs(s.p[1] - p[1]) < tol * 0.6) { p[1] = s.p[1]; hint = hint ? 'aligned' : 'aligned'; break; }
      }
    }
    return { p, hint };
  }
  pickEntity(raw) {
    const tol = this.tol();
    let best = null, bd = tol;
    for (const e of this.entities) {
      let d;
      if (e.type === 'point') d = dist(e.p, raw);
      else { const pts = sample(e, 64); d = Infinity; for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(raw, pts[i], pts[i + 1])); }
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // ------------------------------------------------------------ events
  move(sx, sy) {
    const raw = this.toSketch(sx, sy);
    if (!raw) return;
    this.raw = raw;
    if (this.tool === 'select' && !this.moving) {
      const e = this.pickEntity(raw);
      const id = e ? e.id : null;
      if (id !== this.hover) { this.hover = id; this.redraw(); }
      return;
    }
    const r = this.resolve(raw);
    this.cursor = r.p; this.snap = r.hint;
    if (this.moving) this.applyMove(r.p);
    this.redraw();
    this.ui.sketchStatus();
  }
  click(sx, sy, ev) {
    const raw = this.toSketch(sx, sy);
    if (!raw) return;
    if (this.tool === 'select') {
      if (this.moving) { this.moving = null; this.record(); this.redraw(); return; }
      // clicking a selected entity's end point picks it up to move
      const grab = this.grabPoint(raw);
      if (grab) { this.moving = grab; this.ui.toast('Click to place the point. Connected ends move with it.'); return; }
      const e = this.pickEntity(raw);
      if (!ev.shiftKey && !ev.ctrlKey) this.selected.clear();
      if (e) { if (this.selected.has(e.id) && (ev.shiftKey || ev.ctrlKey)) this.selected.delete(e.id); else this.selected.add(e.id); }
      this.redraw(); this.ui.sketchSelection();
      return;
    }
    const p = this.resolve(raw).p;
    this.addPoint(p);
  }
  // point input from a click or typed coordinates
  addPoint(p) {
    const C = this.construction || undefined;
    const pts = this.pts;
    switch (this.tool) {
      case 'line':
        if (!pts.length) { pts.push(p); this.chainStart = p; break; }
        if (dist(pts[pts.length - 1], p) < 1e-9) break;
        this.entities.push({ id: newId(), type: 'line', a: pts[pts.length - 1].slice(), b: p.slice(), construction: C });
        this.record();
        if (this.chainStart && dist(p, this.chainStart) < 1e-9) { this.reset(); break; } // closed the loop
        pts.push(p);
        break;
      case 'rect': case 'crect':
        if (!pts.length) { pts.push(p); break; }
        this.addRect(pts[0], p, this.tool === 'crect');
        this.reset();
        break;
      case 'circle':
        if (!pts.length) { pts.push(p); break; }
        if (dist(pts[0], p) > 1e-9) { this.entities.push({ id: newId(), type: 'circle', c: pts[0].slice(), r: dist(pts[0], p), construction: C }); this.record(); }
        this.reset();
        break;
      case 'arc':
        if (pts.length < 2) { pts.push(p); break; }
        { const a = arcFrom3(pts[0], p, pts[1]); if (a) { this.entities.push({ id: newId(), type: 'arc', ...a, construction: C }); this.record(); } }
        this.reset();
        break;
      case 'point':
        this.entities.push({ id: newId(), type: 'point', p: p.slice() }); this.record();
        break;
    }
    this.redraw(); this.ui.sketchStatus();
  }
  addRect(a, b, centered) {
    let x0, y0, x1, y1;
    if (centered) { const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); x0 = a[0] - dx; x1 = a[0] + dx; y0 = a[1] - dy; y1 = a[1] + dy; }
    else { x0 = Math.min(a[0], b[0]); x1 = Math.max(a[0], b[0]); y0 = Math.min(a[1], b[1]); y1 = Math.max(a[1], b[1]); }
    if (x1 - x0 < 1e-9 || y1 - y0 < 1e-9) return;
    const C = this.construction || undefined;
    const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let i = 0; i < 4; i++) this.entities.push({ id: newId(), type: 'line', a: c[i], b: c[(i + 1) % 4], construction: C });
    this.record();
  }
  // typed value: length/size/radius or absolute "x,y" for the first point
  submitTyped(text) {
    const t = text.trim();
    if (!t) return false;
    const xy = t.match(/^(-?\d*\.?\d+)\s*[, ]\s*(-?\d*\.?\d+)$/);
    const pts = this.pts, cur = this.cursor || this.raw || [1, 0];
    const num = parseFloat(t);
    if (xy && (!pts.length || this.tool === 'rect' || this.tool === 'crect')) {
      const a = +xy[1], b = +xy[2];
      if (!pts.length) { this.addPoint([a, b]); return true; }
      // rectangle: width,height in the direction of the cursor
      const o = pts[0], sx = cur[0] >= o[0] ? 1 : -1, sy = cur[1] >= o[1] ? 1 : -1;
      this.addPoint(this.tool === 'crect' ? [o[0] + a / 2 * sx, o[1] + b / 2 * sy] : [o[0] + a * sx, o[1] + b * sy]);
      return true;
    }
    if (!isFinite(num) || !pts.length) return false;
    const o = pts[pts.length - 1];
    if (this.tool === 'line') {
      let dx = cur[0] - o[0], dy = cur[1] - o[1]; const L = Math.hypot(dx, dy) || 1;
      if (Math.hypot(dx, dy) < 1e-12) { dx = 1; dy = 0; }
      this.addPoint([o[0] + dx / L * num, o[1] + dy / L * num]);
      return true;
    }
    if (this.tool === 'circle') { this.addPoint([pts[0][0] + Math.abs(num), pts[0][1]]); return true; }
    if (this.tool === 'rect' || this.tool === 'crect') { const sx = cur[0] >= o[0] ? 1 : -1, sy = cur[1] >= o[1] ? 1 : -1; this.addPoint([o[0] + (this.tool === 'crect' ? num / 2 : num) * sx, o[1] + (this.tool === 'crect' ? num / 2 : num) * sy]); return true; }
    return false;
  }
  escape() {
    if (this.moving) { this.entities = JSON.parse(this.history[this.history.length - 1]); this.moving = null; this.redraw(); return true; }
    if (this.pts.length) { this.reset(); this.redraw(); this.ui.sketchStatus(); return true; }
    if (this.selected.size) { this.selected.clear(); this.redraw(); this.ui.sketchSelection(); return true; }
    if (this.tool !== 'select') { this.setTool('select'); return true; }
    return false;
  }
  deleteSelected() {
    if (!this.selected.size) return;
    this.entities = this.entities.filter((e) => !this.selected.has(e.id));
    this.selected.clear(); this.record(); this.redraw(); this.ui.sketchSelection();
  }
  toggleConstruction() {
    if (this.selected.size) {
      for (const e of this.entities) if (this.selected.has(e.id) && e.type !== 'point') e.construction = !e.construction || undefined;
      this.record(); this.redraw();
    } else { this.construction = !this.construction; this.ui.sketchStatus(); }
  }
  // grab an end point / centre to move it (and anything connected to it)
  grabPoint(raw) {
    const tol = this.tol();
    for (const s of this.snapPoints()) if ((s.kind === 'end' || s.kind === 'center' || s.kind === 'point') && dist(s.p, raw) < tol) return { from: s.p.slice(), base: JSON.parse(JSON.stringify(this.entities)) };
    return null;
  }
  applyMove(p) {
    const { from, base } = this.moving;
    const same = (q) => dist(q, from) < 1e-9;
    this.entities = base.map((e) => {
      const n = JSON.parse(JSON.stringify(e));
      if (n.type === 'line') { if (same(n.a)) n.a = p.slice(); if (same(n.b)) n.b = p.slice(); }
      else if (n.type === 'circle') { if (same(n.c)) n.c = p.slice(); }
      else if (n.type === 'point') { if (same(n.p)) n.p = p.slice(); }
      else if (n.type === 'arc') {
        const [s, t] = arcEnds(n), m = arcMid(n);
        if (same(n.c)) { n.c = p.slice(); }
        else if (same(s) || same(t)) { const a = arcFrom3(same(s) ? p : s, m, same(t) ? p : t); if (a) Object.assign(n, a); }
      }
      return n;
    });
  }

  // ------------------------------------------------------------ display
  preview() {
    const p = this.cursor, pts = this.pts, out = [];
    if (!p || !pts.length) return out;
    const C = this.construction || undefined;
    if (this.tool === 'line') out.push({ id: '_p', type: 'line', a: pts[pts.length - 1], b: p, construction: C });
    if (this.tool === 'rect' || this.tool === 'crect') {
      const a = pts[0];
      let x0, x1, y0, y1;
      if (this.tool === 'crect') { const dx = Math.abs(p[0] - a[0]), dy = Math.abs(p[1] - a[1]); x0 = a[0] - dx; x1 = a[0] + dx; y0 = a[1] - dy; y1 = a[1] + dy; }
      else { x0 = a[0]; x1 = p[0]; y0 = a[1]; y1 = p[1]; }
      const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      for (let i = 0; i < 4; i++) out.push({ id: '_p' + i, type: 'line', a: c[i], b: c[(i + 1) % 4], construction: C });
    }
    if (this.tool === 'circle') out.push({ id: '_p', type: 'circle', c: pts[0], r: dist(pts[0], p), construction: C });
    if (this.tool === 'arc') {
      if (pts.length === 1) out.push({ id: '_p', type: 'line', a: pts[0], b: p, construction: true });
      else { const a = arcFrom3(pts[0], p, pts[1]); if (a) out.push({ id: '_p', type: 'arc', ...a, construction: C }); }
    }
    return out;
  }
  redraw() {
    clearGroup(this.group);
    if (!this.active) return;
    const shown = { ...this.feature, entities: [...this.entities, ...this.preview()] };
    const obj = sketchObject(shown, this.plane, { active: true, selected: this.selected, hover: this.hover });
    updateDashes(obj, this.viewer.pixelSize());
    this.group.add(obj);
    // cursor marker
    if (this.cursor && this.tool !== 'select') {
      const w = toWorld(this.plane, this.cursor);
      const s = this.viewer.pixelSize() * (this.snap && this.snap !== 'aligned' && this.snap !== 'horizontal' && this.snap !== 'vertical' ? 6 : 3);
      const mk = new THREE.Mesh(new THREE.RingGeometry(s * 0.6, s, 20), new THREE.MeshBasicMaterial({ color: this.snap ? 0xff7a00 : 0x2462d9, depthTest: false, side: THREE.DoubleSide }));
      mk.position.set(w[0], w[1], w[2]);
      mk.lookAt(mk.position.clone().add(new THREE.Vector3(...this.plane.normal)));
      mk.renderOrder = 30;
      this.group.add(mk);
    }
    this.viewer.render();
  }
  // measurement text for the status bar while drawing
  liveInfo() {
    const p = this.cursor, pts = this.pts;
    if (!p) return '';
    const f = (v) => (Math.round(v * 1000) / 1000).toString();
    if (!pts.length) return `${f(p[0])}, ${f(p[1])}`;
    const o = pts[pts.length - 1];
    if (this.tool === 'line') return `length ${f(dist(o, p))}   angle ${f(((Math.atan2(p[1] - o[1], p[0] - o[0]) * 180 / Math.PI) + 360) % 360)}°${this.snap ? '   ' + this.snap : ''}`;
    if (this.tool === 'rect') return `${f(Math.abs(p[0] - o[0]))} x ${f(Math.abs(p[1] - o[1]))}`;
    if (this.tool === 'crect') return `${f(2 * Math.abs(p[0] - o[0]))} x ${f(2 * Math.abs(p[1] - o[1]))}`;
    if (this.tool === 'circle') return `radius ${f(dist(pts[0], p))}   diameter ${f(2 * dist(pts[0], p))}`;
    return '';
  }
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
export function clearGroup(g) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  }
}
export { sweep };
