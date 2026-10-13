// 2D sketch geometry shared by the sketcher UI and the modelling kernel.
// Entities (sketch coordinates):
//   { id, type: 'line', a: [x, y], b: [x, y] }
//   { id, type: 'circle', c: [x, y], r }
//   { id, type: 'arc', c: [x, y], r, a1, a2 }   counter-clockwise from angle a1 to a2 (radians)
//   { id, type: 'point', p: [x, y] }
// Any entity may carry `construction: true`, which excludes it from profiles.

export const TAU = Math.PI * 2;
const normAng = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };
export const sweep = (a1, a2) => { const s = normAng(a2 - a1); return s < 1e-12 ? TAU : s; };
export const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
export const polar = (c, a, r) => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];

export function arcEnds(e) {
  return [polar(e.c, e.a1, e.r), polar(e.c, e.a2, e.r)];
}
export function arcMid(e) {
  return polar(e.c, e.a1 + sweep(e.a1, e.a2) / 2, e.r);
}

// Circle through three points (null when collinear)
export function circle3(p1, p2, p3) {
  const [ax, ay] = p1, [bx, by] = p2, [cx, cy] = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}
// Arc from start point, a point on the arc, and end point
export function arcFrom3(start, mid, end) {
  const k = circle3(start, mid, end);
  if (!k) return null;
  const as = Math.atan2(start[1] - k.c[1], start[0] - k.c[0]);
  const am = Math.atan2(mid[1] - k.c[1], mid[0] - k.c[0]);
  const ae = Math.atan2(end[1] - k.c[1], end[0] - k.c[0]);
  const ccw = normAng(am - as) < normAng(ae - as);
  return ccw ? { c: k.c, r: k.r, a1: normAng(as), a2: normAng(ae) } : { c: k.c, r: k.r, a1: normAng(ae), a2: normAng(as) };
}

// Sample an entity as a polyline (for display, containment tests and areas)
export function sample(e, segs) {
  if (e.type === 'line') return [e.a, e.b];
  if (e.type === 'circle') {
    const n = segs || 96, out = [];
    for (let i = 0; i <= n; i++) out.push(polar(e.c, (i / n) * TAU, e.r));
    return out;
  }
  if (e.type === 'arc') {
    const s = sweep(e.a1, e.a2), n = segs || Math.max(8, Math.ceil((96 * s) / TAU)), out = [];
    for (let i = 0; i <= n; i++) out.push(polar(e.c, e.a1 + (s * i) / n, e.r));
    return out;
  }
  return [];
}

export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return -a / 2;
}
export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Find closed loops in a sketch. Lines and arcs are chained end to end; circles are loops on their own.
 * Returns { loops: [{ segs: [{ e, rev }], circle?, poly, area }], openEnds } where `poly` is a CCW polygon.
 */
export function findLoops(entities, tol = 1e-6) {
  const curves = entities.filter((e) => !e.construction && (e.type === 'line' || e.type === 'arc'));
  const loops = [];
  for (const e of entities) {
    if (e.construction || e.type !== 'circle' || !(e.r > 0)) continue;
    const poly = sample(e).slice(0, -1);
    loops.push({ segs: [], circle: e, poly, area: Math.PI * e.r * e.r });
  }
  // endpoint graph
  const ends = (e) => (e.type === 'line' ? [e.a, e.b] : arcEnds(e));
  const nodes = [];
  const nodeOf = (p) => {
    for (let i = 0; i < nodes.length; i++) if (dist(nodes[i].p, p) <= tol) return i;
    nodes.push({ p, edges: [] });
    return nodes.length - 1;
  };
  const edges = curves.map((e) => {
    const [s, t] = ends(e);
    const a = nodeOf(s), b = nodeOf(t);
    const ed = { e, a, b, used: false };
    nodes[a].edges.push(ed); nodes[b].edges.push(ed);
    return ed;
  });
  let openEnds = 0;
  for (const n of nodes) if (n.edges.length === 1) openEnds++;
  for (const start of edges) {
    if (start.used || start.a === start.b && start.e.type === 'line') continue;
    // walk only through nodes of degree 2 (simple closed chains)
    const chain = [{ ed: start, rev: false }];
    let node = start.b, ok = true;
    const seen = new Set([start]);
    while (node !== start.a) {
      const n = nodes[node];
      if (n.edges.length !== 2) { ok = false; break; }
      const next = n.edges.find((x) => !seen.has(x));
      if (!next) { ok = false; break; }
      seen.add(next);
      const rev = next.b === node;
      chain.push({ ed: next, rev });
      node = rev ? next.a : next.b;
    }
    if (!ok || nodes[start.a].edges.length !== 2) continue;
    for (const c of chain) c.ed.used = true;
    const segs = chain.map((c) => ({ e: c.ed.e, rev: c.rev }));
    const poly = [];
    for (const s of segs) {
      let pts = sample(s.e);
      if (s.rev) pts = pts.slice().reverse();
      poly.push(...pts.slice(0, -1));
    }
    let area = polyArea(poly);
    if (area < 0) {
      // make every loop counter-clockwise
      segs.reverse(); for (const s of segs) s.rev = !s.rev;
      poly.reverse(); area = -area;
    }
    if (area > tol * tol) loops.push({ segs, poly, area });
  }
  return { loops, openEnds };
}

/**
 * Group loops into regions: a region is an outer loop with the loops directly inside it as holes.
 * Returns [{ outer: loop, holes: [loop], area, centroid }] in a stable order (by outer loop order).
 */
export function findRegions(entities, tol) {
  const { loops, openEnds } = findLoops(entities, tol);
  const inside = (inner, outer) => inner !== outer && inner.area < outer.area && pointInPoly(inner.poly[0], outer.poly) && pointInPoly(inner.poly[Math.floor(inner.poly.length / 2)], outer.poly);
  const depth = loops.map((l) => loops.filter((o) => inside(l, o)).length);
  const regions = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && inside(h, l));
    const area = l.area - holes.reduce((s, h) => s + h.area, 0);
    // a point inside the region (not in a hole), for labelling and picking
    let cx = 0, cy = 0;
    for (const p of l.poly) { cx += p[0]; cy += p[1]; }
    regions.push({ outer: l, holes, area, centroid: [cx / l.poly.length, cy / l.poly.length] });
  });
  return { regions, openEnds };
}

// Region picking: index of the region containing a 2D point (innermost wins)
export function regionAt(regions, p) {
  let best = -1, bestArea = Infinity;
  regions.forEach((r, i) => {
    if (!pointInPoly(p, r.outer.poly)) return;
    if (r.holes.some((h) => pointInPoly(p, h.poly))) return;
    if (r.outer.area < bestArea) { bestArea = r.outer.area; best = i; }
  });
  return best;
}

// Standard and derived sketch planes. A plane is { origin, x, normal } in world coordinates (Z up).
export const STD_PLANES = {
  Top: { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, 0, 1] },
  Front: { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, -1, 0] },
  Right: { origin: [0, 0, 0], x: [0, 1, 0], normal: [1, 0, 0] },
};
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const planeY = (pl) => norm3(cross3(pl.normal, pl.x));
export const toWorld = (pl, p) => add3(add3(pl.origin, mul3(pl.x, p[0])), mul3(planeY(pl), p[1]));
export const toPlane = (pl, w) => { const d = sub3(w, pl.origin); return [dot3(d, pl.x), dot3(d, planeY(pl))]; };
// Build a sketch plane on a planar face: origin at the face centre, x axis chosen to be stable
export function planeOnFace(center, normal) {
  const n = norm3(normal);
  let x = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : norm3(cross3([0, 0, 1], n));
  if (Math.abs(n[2]) > 0.9 && n[2] < 0) x = [1, 0, 0];
  x = norm3(sub3(x, mul3(n, dot3(x, n))));
  return { origin: center.slice(), x, normal: n };
}
