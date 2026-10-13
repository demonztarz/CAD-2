// Partwright modelling kernel: evaluates a parametric feature list with replicad / OpenCascade.
import { findRegions, STD_PLANES, planeY, norm3, sub3, dot3, add3, mul3, cross3, sweep } from './sketch2d.js';

export const PART_COLORS = ['#c9cfd6', '#9fb8d6', '#b9d3a8', '#e2c79a', '#d6a9a9', '#b7a9d6', '#a9d6d0', '#d6c9a9'];

// ---------------------------------------------------------------- planes
export function resolvePlane(doc, ref) {
  if (!ref) return STD_PLANES.Top;
  if (ref.kind === 'std') return STD_PLANES[ref.name] || STD_PLANES.Top;
  if (ref.kind === 'feature') {
    const f = doc.features.find((x) => x.id === ref.id);
    if (f && f.type === 'plane') return planeOfFeature(doc, f);
    return STD_PLANES.Top;
  }
  if (ref.kind === 'explicit') return { origin: ref.origin, x: ref.x, normal: ref.normal };
  return STD_PLANES.Top;
}
export function planeOfFeature(doc, f) {
  const base = resolvePlane(doc, f.base);
  return { origin: add3(base.origin, mul3(base.normal, +f.offset || 0)), x: base.x, normal: base.normal };
}

// ---------------------------------------------------------------- sketch → replicad drawings
function loopDrawing(R, loop) {
  if (loop.circle) return R.drawCircle(loop.circle.r).translate(loop.circle.c[0], loop.circle.c[1]);
  const ends = (s) => {
    const e = s.e;
    let a, b;
    if (e.type === 'line') { a = e.a; b = e.b; }
    else { a = [e.c[0] + Math.cos(e.a1) * e.r, e.c[1] + Math.sin(e.a1) * e.r]; b = [e.c[0] + Math.cos(e.a2) * e.r, e.c[1] + Math.sin(e.a2) * e.r]; }
    return s.rev ? [b, a] : [a, b];
  };
  const first = ends(loop.segs[0])[0];
  let pen = R.draw(first);
  loop.segs.forEach((s, i) => {
    const [, b] = ends(s);
    const target = i === loop.segs.length - 1 ? first : b;
    if (s.e.type === 'line') pen = pen.lineTo(target);
    else {
      const e = s.e, m = e.a1 + sweep(e.a1, e.a2) / 2;
      pen = pen.threePointsArcTo(target, [e.c[0] + Math.cos(m) * e.r, e.c[1] + Math.sin(m) * e.r]);
    }
  });
  return pen.close();
}
function regionDrawings(R, sketch, which) {
  const { regions } = findRegions(sketch.entities || []);
  const pick = which === 'all' || !which ? regions.map((_, i) => i) : which.filter((i) => i >= 0 && i < regions.length);
  return pick.map((i) => {
    const r = regions[i];
    let d = loopDrawing(R, r.outer);
    for (const h of r.holes) d = d.cut(loopDrawing(R, h));
    return d;
  });
}
const rPlane = (R, pl) => new R.Plane(pl.origin, pl.x, pl.normal);

// ---------------------------------------------------------------- reference matching
const v3 = (v) => [v.x, v.y, v.z];
function edgeMid(e) { try { return v3(e.pointAt(0.5)); } catch (_) { return v3(e.startPoint); } }
function faceCenter(f) { return v3(f.center); }
function faceNormal(f) { try { return v3(f.normalAt(f.center)); } catch (_) { return [0, 0, 0]; } }
function modelSize(shape) {
  try { const b = shape.boundingBox; return Math.max(b.width, b.height, b.depth) || 1; } catch (_) { return 1; }
}
// find the edge of `shape` closest to a stored reference
export function matchEdge(shape, ref) {
  const tol = Math.max(1e-4, 1e-3 * modelSize(shape));
  const edges = shape.edges;
  let best = null, bd = Infinity;
  for (const e of edges) {
    const m = edgeMid(e);
    const d = Math.hypot(m[0] - ref.mid[0], m[1] - ref.mid[1], m[2] - ref.mid[2]);
    if (d < bd) { bd = d; best = e; }
  }
  if (bd <= tol * 10) return best;
  // the edge moved or changed length: prefer one that still passes through the old midpoint,
  // then the nearest edge of the same kind running the same way
  const info = edges.map((e) => ({ e, type: safe(() => e.geomType), dir: edgeDir(e), pts: edgeSamples(e) }));
  const sameKind = info.filter((x) => (!ref.type || x.type === ref.type) && (!ref.dir || !x.dir || Math.abs(dot3(ref.dir, x.dir)) > 0.999));
  best = null; bd = Infinity;
  for (const x of sameKind) { const d = polyDist(ref.mid, x.pts); if (d < bd) { bd = d; best = x.e; } }
  if (bd <= tol * 10) return best;
  if (!ref.dir) return null;
  best = null; bd = Infinity;
  for (const x of sameKind) { const m = edgeMid(x.e); const d = Math.hypot(m[0] - ref.mid[0], m[1] - ref.mid[1], m[2] - ref.mid[2]); if (d < bd) { bd = d; best = x.e; } }
  return bd <= 0.35 * modelSize(shape) ? best : null;
}
const safe = (fn) => { try { return fn(); } catch (_) { return null; } };
function edgeDir(e) {
  if (safe(() => e.geomType) !== 'LINE') return null;
  const a = v3(e.startPoint), b = v3(e.endPoint), l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l];
}
function edgeSamples(e) {
  const pts = [];
  for (let i = 0; i <= 16; i++) { const p = safe(() => v3(e.pointAt(i / 16))); if (p) pts.push(p); }
  return pts;
}
function polyDist(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const L = dot3(ab, ab), t = L ? Math.max(0, Math.min(1, dot3(ap, ab) / L)) : 0;
    best = Math.min(best, Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t));
  }
  return best;
}
export function matchFace(shape, ref) {
  const tol = Math.max(1e-4, 1e-3 * modelSize(shape));
  const faces = shape.faces.map((f) => ({ f, c: faceCenter(f), n: faceNormal(f), type: safe(() => f.geomType) }));
  let best = null, bd = Infinity;
  for (const x of faces) {
    const d = Math.hypot(x.c[0] - ref.center[0], x.c[1] - ref.center[1], x.c[2] - ref.center[2]) + (ref.normal ? (1 - dot3(x.n, ref.normal)) * tol * 10 : 0);
    if (d < bd) { bd = d; best = x.f; }
  }
  if (bd <= tol * 10 || !ref.normal) return bd <= tol * 10 ? best : null;
  // the face grew or shrank: a planar face with the same normal whose plane still holds the old centre
  best = null; bd = Infinity;
  for (const x of faces) {
    if (x.type !== 'PLANE' || dot3(x.n, ref.normal) < 0.999) continue;
    const off = Math.abs((ref.center[0] - x.c[0]) * x.n[0] + (ref.center[1] - x.c[1]) * x.n[1] + (ref.center[2] - x.c[2]) * x.n[2]);
    if (off > tol * 10) continue;
    const d = Math.hypot(x.c[0] - ref.center[0], x.c[1] - ref.center[1], x.c[2] - ref.center[2]);
    if (d < bd) { bd = d; best = x.f; }
  }
  return best;
}
const sameEdge = (a, b) => { try { return a.isSame(b); } catch (_) { const m = edgeMid(a), n = edgeMid(b); return Math.hypot(m[0] - n[0], m[1] - n[1], m[2] - n[2]) < 1e-7; } };

// ---------------------------------------------------------------- booleans with parts
function bboxOverlap(a, b) {
  try { return !a.boundingBox.isOut(b.boundingBox); } catch (_) { return true; }
}
function isValidShape(R, s) {
  try { const oc = R.getOC(); const a = new oc.BRepCheck_Analyzer(s.wrapped, true, false); const ok = a.IsValid_2 ? a.IsValid_2() : a.IsValid(); a.delete(); return ok; } catch (_) { return true; }
}
function volumeOf(R, s) { try { return R.measureVolume(s); } catch (_) { return 0; } }
function applyOp(R, parts, tools, op, fid, nextName) {
  const touched = new Set();
  if (op === 'new' || !parts.size) {
    tools.forEach((t, i) => {
      const id = tools.length > 1 ? `${fid}:${i}` : fid;
      parts.set(id, { id, shape: t, name: nextName(), feature: fid });
      touched.add(id);
    });
    return touched;
  }
  for (const tool of tools) {
    if (op === 'add') {
      const hits = [...parts.values()].filter((p) => bboxOverlap(p.shape, tool) && volumeOf(R, p.shape.clone().intersect(tool.clone())) > 1e-9);
      if (!hits.length) {
        const id = `${fid}:${parts.size}`;
        parts.set(id, { id, shape: tool, name: nextName(), feature: fid });
        touched.add(id);
        continue;
      }
      let merged = hits[0].shape.fuse(tool);
      for (const h of hits.slice(1)) { merged = merged.fuse(h.shape); parts.delete(h.id); }
      hits[0].shape = merged; touched.add(hits[0].id);
    } else if (op === 'remove') {
      for (const p of parts.values()) if (bboxOverlap(p.shape, tool)) { p.shape = p.shape.cut(tool.clone()); touched.add(p.id); }
    } else if (op === 'intersect') {
      for (const p of parts.values()) {
        if (bboxOverlap(p.shape, tool)) { p.shape = p.shape.intersect(tool.clone()); touched.add(p.id); }
        else parts.delete(p.id);
      }
    }
  }
  // drop parts that a cut or intersect emptied
  for (const p of [...parts.values()]) if (volumeOf(R, p.shape) < 1e-12) parts.delete(p.id);
  return touched;
}

// ---------------------------------------------------------------- evaluation
/**
 * Evaluate a document. Returns { parts: Map id -> {id, name, shape, feature}, status: {featureId: {ok, error?, warning?}} }.
 * `upTo` limits evaluation to the first N features (rollback / preview).
 */
export async function evaluate(R, doc, upTo) {
  const parts = new Map();
  const status = {};
  const feats = doc.features.slice(0, upTo == null ? doc.features.length : upTo);
  let partNo = 0;
  const nextName = () => `Part ${++partNo}`;
  for (const f of feats) {
    if (f.suppressed) { status[f.id] = { ok: true, suppressed: true }; continue; }
    try {
      status[f.id] = await evalFeature(R, doc, f, parts, nextName) || { ok: true };
    } catch (err) {
      status[f.id] = { ok: false, error: cleanError(err) };
    }
  }
  // user-assigned names and colours
  for (const p of parts.values()) {
    const meta = (doc.partMeta || {})[p.id];
    if (meta && meta.name) p.name = meta.name;
    p.color = (meta && meta.color) || PART_COLORS[[...parts.keys()].indexOf(p.id) % PART_COLORS.length];
  }
  return { parts, status };
}
function cleanError(err) {
  const m = String((err && err.message) || err || 'Failed');
  if (/BRep_API|StdFail|Standard_|null shape|not done/i.test(m)) return 'The geometry could not be built with these values.';
  return m.length > 160 ? m.slice(0, 160) + '...' : m;
}

async function evalFeature(R, doc, f, parts, nextName) {
  switch (f.type) {
    case 'sketch': case 'plane': return { ok: true };
    case 'extrude': {
      const sk = doc.features.find((x) => x.id === f.sketch && x.type === 'sketch');
      if (!sk) throw new Error('Select a sketch to extrude.');
      const pl = resolvePlane(doc, sk.plane);
      const depth = +f.depth;
      if (!(depth > 0)) throw new Error('Depth must be greater than zero.');
      const drawings = regionDrawings(R, sk, f.regions);
      if (!drawings.length) throw new Error('The sketch has no closed regions.');
      const sign = f.flip ? -1 : 1;
      let origin = pl.origin, len = depth * sign;
      if (f.mode === 'symmetric') { origin = add3(pl.origin, mul3(pl.normal, -depth / 2 * sign)); len = depth * sign; }
      const plane = { origin, x: pl.x, normal: pl.normal };
      const tools = drawings.map((d) => {
        const s = d.sketchOnPlane(rPlane(R, plane));
        return len > 0 ? s.extrude(len) : s.extrude(len);
      });
      applyOp(R, parts, tools, f.op || 'new', f.id, nextName);
      return { ok: true };
    }
    case 'revolve': {
      const sk = doc.features.find((x) => x.id === f.sketch && x.type === 'sketch');
      if (!sk) throw new Error('Select a sketch to revolve.');
      const pl = resolvePlane(doc, sk.plane);
      const drawings = regionDrawings(R, sk, f.regions);
      if (!drawings.length) throw new Error('The sketch has no closed regions.');
      // axis: a sketch line, or the sketch's horizontal / vertical axis through its origin
      let o = pl.origin, dir = f.axis === 'x' ? pl.x : planeY(pl);
      if (f.axis && f.axis.startsWith && f.axis.startsWith('line:')) {
        const ln = (sk.entities || []).find((e) => e.id === f.axis.slice(5) && e.type === 'line');
        if (!ln) throw new Error('The revolve axis line no longer exists.');
        const yv = planeY(pl);
        const w = (p) => add3(add3(pl.origin, mul3(pl.x, p[0])), mul3(yv, p[1]));
        o = w(ln.a); dir = norm3(sub3(w(ln.b), w(ln.a)));
      }
      const ang = Math.max(0.01, Math.min(360, +f.angle || 360));
      const tools = drawings.map((d) => d.sketchOnPlane(rPlane(R, pl)).revolve(dir, { origin: o, angle: ang }));
      applyOp(R, parts, tools, f.op || 'new', f.id, nextName);
      return { ok: true };
    }
    case 'fillet': case 'chamfer': {
      const size = +f.size;
      if (!(size > 0)) throw new Error('Size must be greater than zero.');
      let missing = 0;
      const byPart = new Map();
      for (const ref of f.edges || []) {
        const p = parts.get(ref.part);
        const edge = p && matchEdge(p.shape, ref);
        if (!edge) { missing++; continue; }
        if (!byPart.has(p)) byPart.set(p, []);
        byPart.get(p).push(edge);
      }
      if (!byPart.size) throw new Error(f.edges && f.edges.length ? 'The selected edges no longer exist.' : 'Select edges.');
      for (const [p, edges] of byPart) {
        const pick = (e) => (edges.some((x) => sameEdge(x, e)) ? size : null);
        p.shape = f.type === 'fillet' ? p.shape.fillet(pick) : p.shape.chamfer(pick);
      }
      return missing ? { ok: true, warning: `${missing} edge reference(s) could not be found.` } : { ok: true };
    }
    case 'shell': {
      const t = +f.thickness;
      if (!(t > 0)) throw new Error('Thickness must be greater than zero.');
      const ref = (f.faces || [])[0];
      if (!ref) throw new Error('Select the face(s) to remove.');
      const p = parts.get(ref.part);
      if (!p) throw new Error('The selected part no longer exists.');
      const faces = (f.faces || []).filter((r) => r.part === ref.part).map((r) => matchFace(p.shape, r)).filter(Boolean);
      if (!faces.length) throw new Error('The selected faces no longer exist.');
      const finder = new R.FaceFinder().when(({ element }) => faces.some((x) => { try { return x.isSame(element); } catch (_) { return false; } }));
      const before = volumeOf(R, p.shape);
      const out = p.shape.shell({ filter: finder, thickness: t }); // positive thickness grows the walls inward
      // the offset algorithm can return a broken solid instead of failing (typically when a fillet
      // runs tangent into a removed face); never let that through as if it worked
      const after = volumeOf(R, out);
      if (!isValidShape(R, out) || !(after > 0) || after >= before) throw new Error('The shell could not be built with these faces and thickness. Try a thinner wall, or add the shell before fillets that touch the removed faces.');
      p.shape = out;
      return { ok: true };
    }
    case 'pattern': {
      const src = (f.parts || []).map((id) => parts.get(id)).filter(Boolean);
      if (!src.length) throw new Error('Select parts to pattern.');
      const n = Math.max(2, Math.min(200, Math.round(+f.count || 2)));
      const tools = [];
      for (const p of src) {
        for (let i = 1; i < n; i++) {
          if (f.kind === 'circular') {
            const ang = (f.angle == null ? 360 : +f.angle) * (Math.abs((+f.angle || 360) - 360) < 1e-9 ? i / n : i / (n - 1));
            const axis = f.axis === 'x' ? [1, 0, 0] : f.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
            tools.push(p.shape.clone().rotate(ang, [0, 0, 0], axis));
          } else {
            const d = (+f.spacing || 10) * i;
            const v = f.axis === 'y' ? [0, d, 0] : f.axis === 'z' ? [0, 0, d] : [d, 0, 0];
            tools.push(p.shape.clone().translate(v));
          }
        }
      }
      applyOp(R, parts, tools, f.op === 'add' ? 'add' : 'new', f.id, nextName);
      return { ok: true };
    }
    case 'mirror': {
      const src = (f.parts || []).map((id) => parts.get(id)).filter(Boolean);
      if (!src.length) throw new Error('Select parts to mirror.');
      const pl = resolvePlane(doc, f.plane);
      const tools = src.map((p) => p.shape.clone().mirror(pl.normal, pl.origin));
      applyOp(R, parts, tools, f.op === 'add' ? 'add' : 'new', f.id, nextName);
      return { ok: true };
    }
    case 'import': {
      if (!f.data) throw new Error('No file data.');
      const blob = new Blob([f.format === 'stl' ? Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)) : f.data]);
      const shape = f.format === 'stl' ? await R.importSTL(blob) : await R.importSTEP(blob);
      const solids = [];
      try { for (const s of shape.solids || []) solids.push(s); } catch (_) { /* not a compound */ }
      applyOp(R, parts, solids.length ? solids : [shape], 'new', f.id, nextName);
      return { ok: true };
    }
    default:
      throw new Error(`Unknown feature type "${f.type}".`);
  }
}

// ---------------------------------------------------------------- display data
export function tessellate(R, part, quality = 1) {
  const s = part.shape;
  const tol = Math.max(0.01, modelSize(s) / 600) / quality;
  const mesh = s.mesh({ tolerance: tol, angularTolerance: 0.25 });
  const edges = s.meshEdges({ tolerance: tol, angularTolerance: 0.25 });
  const faceList = s.faces;
  // mesh groups identify faces/edges by hash code; map them to list indices
  const faceIndex = new Map(faceList.map((fc, i) => [fc.hashCode, i]));
  const edgeIndex = new Map(s.edges.map((e, i) => [e.hashCode, i]));
  const faceGroups = mesh.faceGroups.map((g) => ({ start: g.start, count: g.count, faceId: faceIndex.get(g.faceId) ?? -1 }));
  const edgeGroups = edges.edgeGroups.map((g) => ({ start: g.start, count: g.count, edgeId: edgeIndex.get(g.edgeId) ?? -1 }));
  const faces = faceList.map((fc, i) => {
    let area = 0;
    try { area = R.measureArea(fc); } catch (_) { /* ignore */ }
    return { i, type: fc.geomType, center: faceCenter(fc), normal: faceNormal(fc), area };
  });
  const edgeList = s.edges.map((e, i) => {
    let length = 0;
    try { length = e.length; } catch (_) { /* ignore */ }
    return { i, type: e.geomType, mid: edgeMid(e), start: v3(e.startPoint), end: v3(e.endPoint), length };
  });
  let volume = 0;
  try { volume = R.measureVolume(s); } catch (_) { /* ignore */ }
  return {
    id: part.id, name: part.name, color: part.color, volume,
    vertices: new Float32Array(mesh.vertices), normals: new Float32Array(mesh.normals), triangles: new Uint32Array(mesh.triangles),
    faceGroups, lines: new Float32Array(edges.lines), edgeGroups,
    faces, edges: edgeList,
  };
}

export function exportParts(R, parts, ids, format) {
  const list = [...parts.values()].filter((p) => !ids || !ids.length || ids.includes(p.id));
  if (!list.length) throw new Error('There are no parts to export.');
  if (format === 'stl') {
    let shape = list[0].shape.clone();
    for (const p of list.slice(1)) shape = shape.fuse(p.shape.clone());
    return shape.blobSTL({ binary: true });
  }
  return R.exportSTEP(list.map((p) => ({ shape: p.shape, name: p.name, color: p.color })));
}

export { cross3 };
