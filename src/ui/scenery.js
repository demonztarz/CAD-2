// Scene objects for sketches, sketch regions and reference planes.
import * as THREE from 'three';
import { findRegions, sample, toWorld, planeY } from '../kernel/sketch2d.js';

export const COLORS = {
  sketch: 0x2462d9, construction: 0xe8860c, selected: 0xff7a00, hover: 0x5aa0ff, region: 0x7fb0ff, regionSel: 0xffb066,
  plane: 0x7f9cc0, planeSel: 0xff9a3c, point: 0x1d3f8a,
};

const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
export function planeMatrix(pl) {
  const x = v(pl.x), n = v(pl.normal), y = v(planeY(pl));
  return new THREE.Matrix4().makeBasis(x, y, n).setPosition(v(pl.origin));
}

// Sketch display group. state: { selected:Set, hover, selectedRegions:Set, active }
export function sketchObject(sketch, plane, state = {}) {
  const g = new THREE.Group();
  g.userData.sketchId = sketch.id;
  const m = planeMatrix(plane);
  const ents = sketch.entities || [];
  const { regions } = findRegions(ents);
  regions.forEach((r, i) => {
    const shape = new THREE.Shape(r.outer.poly.map((p) => new THREE.Vector2(p[0], p[1])));
    for (const h of r.holes) shape.holes.push(new THREE.Path(h.poly.map((p) => new THREE.Vector2(p[0], p[1]))));
    const sel = state.selectedRegions && state.selectedRegions.has(i);
    const hov = state.hoverRegion === i;
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
      color: sel ? COLORS.regionSel : COLORS.region, transparent: true, opacity: sel ? 0.55 : hov ? 0.45 : 0.22, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    }));
    mesh.applyMatrix4(m);
    mesh.userData = { kind: 'region', sketch: sketch.id, region: i };
    mesh.renderOrder = 5;
    g.add(mesh);
  });
  for (const e of ents) {
    const sel = state.selected && state.selected.has(e.id), hov = state.hover === e.id;
    const color = sel ? COLORS.selected : hov ? COLORS.hover : e.construction ? COLORS.construction : COLORS.sketch;
    if (e.type === 'point') {
      const pt = new THREE.Points(new THREE.BufferGeometry().setFromPoints([v(toWorld(plane, e.p))]), new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false }));
      pt.renderOrder = 20; pt.userData = { kind: 'entity', id: e.id };
      g.add(pt);
      continue;
    }
    const pts = sample(e).map((p) => v(toWorld(plane, p)));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = e.construction
      ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 1, depthTest: !state.active })
      : new THREE.LineBasicMaterial({ color, depthTest: !state.active });
    const line = new THREE.Line(geo, mat);
    if (e.construction) { line.computeLineDistances(); line.userData.dashed = true; }
    line.renderOrder = 10;
    line.userData = { kind: 'entity', id: e.id, dashed: !!e.construction };
    g.add(line);
  }
  if (state.active) {
    // endpoints as small dots
    const pts = [];
    for (const e of ents) {
      if (e.type === 'line') pts.push(e.a, e.b);
      else if (e.type === 'arc') { pts.push(sample(e, 1)[0], sample(e, 1)[1], e.c); }
      else if (e.type === 'circle') pts.push(e.c);
    }
    if (pts.length) {
      const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts.map((q) => v(toWorld(plane, q)))), new THREE.PointsMaterial({ color: COLORS.point, size: 5, sizeAttenuation: false, depthTest: false }));
      p.renderOrder = 21;
      g.add(p);
    }
  }
  return g;
}

// keep dashed construction lines readable at any zoom
export function updateDashes(group, worldPerPixel) {
  group.traverse((o) => {
    if (o.userData && o.userData.dashed && o.material && o.material.isLineDashedMaterial) {
      o.material.dashSize = 6 * worldPerPixel; o.material.gapSize = 4 * worldPerPixel;
    }
  });
}

// Reference plane: translucent square with border and label
export function planeObject(name, plane, size, state = {}) {
  const g = new THREE.Group();
  const m = planeMatrix(plane);
  const color = state.selected ? COLORS.planeSel : state.hover ? COLORS.hover : COLORS.plane;
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: state.selected ? 0.25 : 0.1, side: THREE.DoubleSide, depthWrite: false }));
  fill.applyMatrix4(m);
  fill.userData = { kind: 'plane', name };
  fill.renderOrder = 2;
  const h = size / 2;
  const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-h, -h], [h, -h], [h, h], [-h, h]].map((p) => new THREE.Vector3(p[0], p[1], 0))), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
  border.applyMatrix4(m);
  g.add(fill, border);
  // label sprite in the corner
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '600 34px "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = state.selected ? '#c45f00' : '#4a6a92';
  ctx.fillText(name, 6, 44);
  const tex = new THREE.CanvasTexture(c);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.32, size * 0.08), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  label.position.set(-h + size * 0.17, h - size * 0.05, 0);
  label.applyMatrix4(m);
  label.renderOrder = 3;
  g.add(label);
  g.userData = { kind: 'plane', name };
  return g;
}

// small origin marker
export function originObject(size) {
  const g = new THREE.Group();
  const s = size * 0.06;
  const axes = [[1, 0, 0, 0xd23b3b], [0, 1, 0, 0x2f9e44], [0, 0, 1, 0x2f6fd2]];
  for (const [x, y, z, c] of axes) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(x * s, y * s, z * s)]), new THREE.LineBasicMaterial({ color: c })));
  return g;
}
