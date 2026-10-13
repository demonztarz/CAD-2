// Kernel tests with the real OpenCascade build. Run with: node test/kernel.test.mjs
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import opencascade from 'replicad-opencascadejs';
import * as R from 'replicad';
import { evaluate, tessellate, exportParts, matchEdge } from '../src/kernel/model.js';
import { findRegions, arcFrom3, regionAt } from '../src/kernel/sketch2d.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = fs.readFileSync(path.join(here, '..', 'node_modules', 'replicad-opencascadejs', 'dist', 'replicad_single.wasm'));
R.setOC(await opencascade({ wasmBinary: wasm }));

let passed = 0;
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { console.error('FAIL', name, '\n ', e.stack); process.exitCode = 1; }
}
const rect = (id, x0, y0, x1, y1) => [
  { id: id + 'a', type: 'line', a: [x0, y0], b: [x1, y0] }, { id: id + 'b', type: 'line', a: [x1, y0], b: [x1, y1] },
  { id: id + 'c', type: 'line', a: [x1, y1], b: [x0, y1] }, { id: id + 'd', type: 'line', a: [x0, y1], b: [x0, y0] },
];
const doc = (features) => ({ format: 'Partwright', version: 1, features, partMeta: {} });

await test('regions: rectangle with a circular hole', () => {
  const ents = [...rect('r', 0, 0, 40, 20), { id: 'c', type: 'circle', c: [20, 10], r: 5 }];
  const { regions } = findRegions(ents);
  assert.strictEqual(regions.length, 1);
  near(regions[0].area, 800 - Math.PI * 25, 1e-3);
  assert.strictEqual(regionAt(regions, [20, 10]), -1); // inside the hole
  assert.strictEqual(regionAt(regions, [2, 2]), 0);
});

await test('regions: arcs chained with lines (slot)', () => {
  const top = { id: 't', type: 'line', a: [0, 5], b: [20, 5] }, bot = { id: 'b', type: 'line', a: [20, -5], b: [0, -5] };
  const right = { id: 'r', type: 'arc', ...arcFrom3([20, -5], [25, 0], [20, 5]) };
  const left = { id: 'l', type: 'arc', ...arcFrom3([0, 5], [-5, 0], [0, -5]) };
  const { regions } = findRegions([top, right, bot, left]);
  assert.strictEqual(regions.length, 1);
  near(regions[0].area, 200 + Math.PI * 25, 1e-2);
});

await test('extrude a plate, cut a hole, volume is exact', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 40, 20) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 10, op: 'new' },
    { id: 's2', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: [{ id: 'h', type: 'circle', c: [20, 10], r: 4 }] },
    { id: 'e2', type: 'extrude', sketch: 's2', regions: 'all', depth: 10, op: 'remove' },
  ]);
  const { parts, status } = await evaluate(R, d);
  assert.ok(Object.values(status).every((s) => s.ok), JSON.stringify(status));
  assert.strictEqual(parts.size, 1);
  near(R.measureVolume([...parts.values()][0].shape), 8000 - Math.PI * 16 * 10, 1e-6);
});

await test('fillet survives an upstream dimension change', async () => {
  const mk = (h) => doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 40, 20) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: h, op: 'new' },
    // vertical edge at x=40, y=20: its midpoint moves when the height changes, so it is stored at the original height
    { id: 'f1', type: 'fillet', edges: [{ part: 'e1', mid: [40, 20, 5] }], size: 3 },
  ]);
  const a = await evaluate(R, mk(10));
  assert.ok(a.status.f1.ok, JSON.stringify(a.status.f1));
  const p = [...a.parts.values()][0];
  near(R.measureVolume(p.shape), 8000 - (9 - Math.PI * 9 / 4) * 10, 1e-6);
  const t = tessellate(R, p);
  assert.ok(t.faces.length === 7 && t.triangles.length > 0, `faces ${t.faces.length}`);
});

await test('symmetric extrude and revolve', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Front' }, entities: rect('p', 10, 0, 20, 30) },
    { id: 'r1', type: 'revolve', sketch: 's1', regions: 'all', axis: 'y', angle: 360, op: 'new' },
  ]);
  const { parts, status } = await evaluate(R, d);
  assert.ok(status.r1.ok, JSON.stringify(status.r1));
  // ring: pi*(20^2-10^2)*30
  near(R.measureVolume([...parts.values()][0].shape), Math.PI * 300 * 30, 1e-5);
  const d2 = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 10, 10) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 20, mode: 'symmetric', op: 'new' },
  ]);
  const r2 = await evaluate(R, d2);
  const bb = [...r2.parts.values()][0].shape.boundingBox.bounds;
  near(bb[0][2], -10); near(bb[1][2], 10);
});

await test('shell removes the top face', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 40, 20) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 10, op: 'new' },
    { id: 'sh', type: 'shell', faces: [{ part: 'e1', center: [20, 10, 10], normal: [0, 0, 1] }], thickness: 2 },
  ]);
  const { parts, status } = await evaluate(R, d);
  assert.ok(status.sh.ok, JSON.stringify(status.sh));
  near(R.measureVolume([...parts.values()][0].shape), 8000 - 36 * 16 * 8, 1e-6);
});

await test('errors are reported per feature and evaluation continues', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: [{ id: 'l', type: 'line', a: [0, 0], b: [10, 0] }] },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 10, op: 'new' },
    { id: 's2', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: [{ id: 'c', type: 'circle', c: [0, 0], r: 5 }] },
    { id: 'e2', type: 'extrude', sketch: 's2', regions: 'all', depth: 5, op: 'new' },
  ]);
  const { parts, status } = await evaluate(R, d);
  assert.strictEqual(status.e1.ok, false);
  assert.ok(status.e2.ok);
  assert.strictEqual(parts.size, 1);
});

await test('STEP export and re-import round trip', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: [{ id: 'c', type: 'circle', c: [0, 0], r: 10 }] },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 5, op: 'new' },
  ]);
  const { parts } = await evaluate(R, d);
  const blob = exportParts(R, parts, null, 'step');
  const text = await blob.text();
  assert.ok(text.startsWith('ISO-10303-21'), text.slice(0, 40));
  const d2 = doc([{ id: 'i1', type: 'import', format: 'step', data: text }]);
  const r2 = await evaluate(R, d2);
  assert.ok(r2.status.i1.ok, JSON.stringify(r2.status.i1));
  near(R.measureVolume([...r2.parts.values()][0].shape), Math.PI * 100 * 5, 1e-4);
});

await test('mesh face groups line up with face indices', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 40, 20) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 10, op: 'new' },
  ]);
  const { parts } = await evaluate(R, d);
  const t = tessellate(R, [...parts.values()][0]);
  for (const g of t.faceGroups) {
    const face = t.faces[g.faceId];
    assert.ok(face, `no face ${g.faceId}`);
    // first triangle's first vertex lies on the face's plane
    const vi = t.triangles[g.start];
    const v = [t.vertices[vi * 3], t.vertices[vi * 3 + 1], t.vertices[vi * 3 + 2]];
    const dd = (v[0] - face.center[0]) * face.normal[0] + (v[1] - face.center[1]) * face.normal[1] + (v[2] - face.center[2]) * face.normal[2];
    assert.ok(Math.abs(dd) < 1e-6, `face ${g.faceId} off plane by ${dd}`);
  }
  assert.ok(matchEdge([...parts.values()][0].shape, { mid: [20, 0, 0] }));
});

await test('fillet and shell follow references when the extrude depth changes', async () => {
  const mk = (depth) => doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 40, 20) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth, op: 'new' },
    { id: 'f1', type: 'fillet', edges: [{ part: 'e1', mid: [40, 0, 5], type: 'LINE', dir: [0, 0, 1] }], size: 3 },
    { id: 'h1', type: 'shell', faces: [{ part: 'e1', center: [20, 20, 5], normal: [0, 1, 0] }], thickness: 1 },
  ]);
  const a = await evaluate(R, mk(10));
  assert.ok(a.status.f1.ok && a.status.h1.ok, JSON.stringify(a.status));
  const b = await evaluate(R, mk(30));
  assert.ok(b.status.f1.ok && b.status.h1.ok, JSON.stringify(b.status));
  assert.ok(R.measureVolume([...b.parts.values()][0].shape) < 40 * 20 * 30 / 2, 'shell hollowed the part');
});

await test('a shell the offset algorithm cannot build is reported, not returned broken', async () => {
  const d = doc([
    { id: 's1', type: 'sketch', plane: { kind: 'std', name: 'Top' }, entities: rect('p', 0, 0, 40, 20) },
    { id: 'e1', type: 'extrude', sketch: 's1', regions: 'all', depth: 10, op: 'new' },
    { id: 'f1', type: 'fillet', edges: [{ part: 'e1', mid: [40, 0, 5] }], size: 6 },
    { id: 'h1', type: 'shell', faces: [{ part: 'e1', center: [17, 0, 5], normal: [0, -1, 0] }], thickness: 2 },
  ]);
  const r = await evaluate(R, d);
  assert.equal(r.status.h1.ok, false, JSON.stringify(r.status.h1));
  near(R.measureVolume([...r.parts.values()][0].shape), 8000 - (36 - 9 * Math.PI) * 10, 1e-6);
});

console.log(`${passed} kernel tests passed${process.exitCode ? ' (with failures)' : ''}`);
