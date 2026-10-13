// Partwright application: feature tree, toolbar, feature dialogs, selection, sketch mode, files.
import { Viewer, THREE } from './viewer.js';
import { Sketcher, newId, clearGroup } from './sketcher.js';
import { sketchObject, planeObject, originObject, updateDashes } from './scenery.js';
import { icon } from './icons.js';
import { STD_PLANES, planeOnFace, findRegions, planeY } from '../kernel/sketch2d.js';
import { resolvePlane } from '../kernel/model.js';

const $ = (id) => document.getElementById(id);
const desk = window.desktop || null;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'cls') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fmt = (v, d = 3) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });

// ====================================================================== state
const newDoc = () => ({ format: 'Partwright', version: 1, name: 'Untitled', units: 'mm', features: [], partMeta: {}, planes: { Top: true, Front: true, Right: true } });
const App = (window.App = {
  doc: newDoc(), file: { path: null, dirty: false },
  result: { parts: [], status: {} }, selection: [], hover: null,
  mode: 'idle', treeSel: null, undo: [], redo: [],
});

// ====================================================================== kernel worker
const worker = new Worker(new URL('worker.js', location.href), { type: 'module' });
worker.postMessage({ cmd: 'config', wasmUrl: new URL('replicad_single.wasm', location.href).href });
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
worker.onerror = (e) => toast(`Modelling engine error: ${e.message || e}`, 'err');
const call = (cmd, payload = {}) => new Promise((res) => { const id = ++reqId; pending.set(id, res); worker.postMessage({ id, cmd, ...payload }); });
App.call = call;

let busyCount = 0;
const busy = (on) => { busyCount += on ? 1 : -1; $('busy').classList.toggle('hidden', busyCount <= 0); };
let rebuildSeq = 0;
async function rebuild() {
  const seq = ++rebuildSeq;
  busy(true);
  const r = await call('rebuild', { doc: App.doc });
  busy(false);
  if (r.superseded || seq !== rebuildSeq) return;
  if (!r.ok) { toast(r.error, 'err'); return; }
  App.result = r;
  // drop selections that refer to parts that no longer exist
  App.selection = App.selection.filter((s) => !s.part || r.parts.some((p) => p.id === s.part));
  if (App.mode !== 'dialog') refreshScene();
  renderTree(); updateInfo();
  App.lastBuildMs = r.ms;
  App.emit && App.emit('rebuilt');
}
App.rebuild = rebuild;

// ====================================================================== viewer
let viewer;
try { viewer = new Viewer($('viewport'), $('cube')); } catch (err) {
  document.body.innerHTML = `<div style="margin:12vh auto;max-width:560px;font:15px/1.6 Segoe UI,system-ui,sans-serif;color:#22303c"><h2>Partwright could not start 3D graphics</h2><p>Your computer did not provide a working WebGL context (${String(err.message || err).replace(/[<>&]/g, '')}).</p><p>Update your graphics driver, or make sure hardware acceleration is not disabled, then start Partwright again.</p></div>`;
  throw err;
}
App.viewer = viewer;
const sketcher = new Sketcher(viewer, {
  sketchStatus: () => sketchStatus(), sketchChanged: () => sketchPanel(), sketchSelection: () => sketchPanel(), toast: (m) => toast(m),
});
App.sketcher = sketcher;
const origin = originObject(100);
viewer.scene.add(origin);

function modelSize() {
  let r = 0;
  for (const p of viewer.parts.values()) { const s = p.mesh.geometry.boundingSphere; if (s) r = Math.max(r, s.center.length() + s.radius); }
  return Math.max(60, r * 1.2);
}
function refreshScene(parts) {
  const list = (parts || App.result.parts).map((p) => ({ ...p, hidden: !!(App.doc.partMeta[p.id] || {}).hidden }));
  viewer.setParts(list);
  drawReferences();
  applyHighlights();
}
function drawReferences() {
  clearGroup(viewer.groups.sketches); clearGroup(viewer.groups.planes);
  const size = modelSize();
  const selKeys = new Set(App.selection.map(selKey));
  const hk = App.hover ? selKey(App.hover) : '';
  for (const name of ['Top', 'Front', 'Right']) {
    if (App.doc.planes[name] === false) continue;
    const key = selKey({ kind: 'plane', ref: { kind: 'std', name } });
    viewer.groups.planes.add(planeObject(name, STD_PLANES[name], size, { selected: selKeys.has(key), hover: hk === key }));
  }
  for (const f of App.doc.features) {
    if (f.suppressed || f.hidden) continue;
    if (f.type === 'plane') {
      const key = selKey({ kind: 'plane', ref: { kind: 'feature', id: f.id } });
      const g = planeObject(f.name, resolvePlane(App.doc, { kind: 'feature', id: f.id }), size * 0.8, { selected: selKeys.has(key), hover: hk === key });
      g.traverse((o) => { if (o.userData.kind === 'plane') o.userData.featureId = f.id; });
      viewer.groups.planes.add(g);
    }
    if (f.type === 'sketch' && !(App.mode === 'sketch' && sketcher.feature && sketcher.feature.id === f.id)) {
      const regions = new Set(App.selection.filter((s) => s.kind === 'region' && s.sketch === f.id).map((s) => s.region));
      const hoverRegion = App.hover && App.hover.kind === 'region' && App.hover.sketch === f.id ? App.hover.region : -1;
      const obj = sketchObject(f, resolvePlane(App.doc, f.plane), { selectedRegions: regions, hoverRegion });
      updateDashes(obj, viewer.pixelSize());
      viewer.groups.sketches.add(obj);
    }
  }
  origin.scale.setScalar(size / 100);
  viewer.applyClip();
  viewer.render();
}

// ====================================================================== selection & picking
function selKey(s) {
  switch (s.kind) {
    case 'face': case 'edge': return `${s.kind}:${s.part}:${s.index}`;
    case 'part': return `part:${s.part}`;
    case 'region': return `region:${s.sketch}:${s.region}`;
    case 'plane': return `plane:${s.ref.kind}:${s.ref.name || s.ref.id}`;
    default: return JSON.stringify(s);
  }
}
const IDLE_KINDS = { edge: true, face: true, region: true, plane: true };
function pickAt(sx, sy, kinds) {
  const ray = viewer.screenToRay(sx, sy);
  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(viewer.quat);
  const depth = (p) => p.clone().sub(viewer.camera.position).dot(camDir);
  const partPicks = viewer.pick(sx, sy, { edge: kinds.edge, face: kinds.face || kinds.planarFace, part: kinds.part });
  const edge = partPicks.find((p) => p.kind === 'edge');
  if (edge) return edge;
  const cands = [];
  const face = partPicks.find((p) => p.kind === 'face');
  if (face && (kinds.face || (kinds.planarFace && face.info && face.info.type === 'PLANE'))) cands.push({ item: face, d: depth(face.point) });
  const part = partPicks.find((p) => p.kind === 'part');
  if (part && kinds.part) cands.push({ item: part, d: depth(part.point) });
  const eps = viewer.pixelSize() * 3;
  if (kinds.region) {
    const meshes = [];
    viewer.groups.sketches.traverse((o) => { if (o.userData && o.userData.kind === 'region') meshes.push(o); });
    const hit = ray.intersectObjects(meshes, false)[0];
    if (hit) cands.push({ item: { kind: 'region', sketch: hit.object.userData.sketch, region: hit.object.userData.region }, d: depth(hit.point) - eps });
  }
  if (kinds.plane) {
    const meshes = [];
    viewer.groups.planes.traverse((o) => { if (o.userData && o.userData.kind === 'plane' && o.isMesh) meshes.push(o); });
    const hit = ray.intersectObjects(meshes, false)[0];
    if (hit) {
      const ud = hit.object.userData;
      cands.push({ item: { kind: 'plane', ref: ud.featureId ? { kind: 'feature', id: ud.featureId } : { kind: 'std', name: ud.name } }, d: depth(hit.point) + eps });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  return cands.length ? cands[0].item : null;
}
function currentKinds() {
  if (App.mode === 'dialog' && D && D.activeField) {
    const k = {};
    for (const kind of D.activeField.kinds) k[kind] = true;
    return k;
  }
  return IDLE_KINDS;
}
function applyHighlights() {
  viewer.clearHighlights();
  const geo = App.selection.filter((s) => s.kind === 'face' || s.kind === 'edge' || s.kind === 'part');
  viewer.highlight(geo, 0xff7a00, 3);
  if (App.hover && (App.hover.kind === 'face' || App.hover.kind === 'edge' || App.hover.kind === 'part') && !App.selection.some((s) => selKey(s) === selKey(App.hover))) viewer.highlight([App.hover], 0x4a90ff, 2.5);
}
function setSelection(list) { App.selection = list; drawReferences(); applyHighlights(); updateInfo(); renderTree(); }
App.setSelection = setSelection;
// a click on a tree row: feeds the open feature dialog when it wants that kind of item
function treePick(item, e) {
  if (App.mode === 'dialog' && D && D.activeField) {
    const kinds = D.activeField.kinds;
    if (kinds.includes(item.kind) || (kinds.includes('part') && item.part)) dialogPick(item);
    else toast(`This box needs ${kindText(kinds)}.`);
    return;
  }
  toggleSelect(item, e.shiftKey || e.ctrlKey);
  renderTree();
}
function toggleSelect(item, additive) {
  const k = selKey(item);
  const has = App.selection.some((s) => selKey(s) === k);
  if (!additive) App.selection = has && App.selection.length === 1 ? [] : [item];
  else App.selection = has ? App.selection.filter((s) => selKey(s) !== k) : [...App.selection, item];
  drawReferences(); applyHighlights(); updateInfo();
}

let hoverRaf = 0;
viewer.on('hover', (sx, sy) => {
  if (App.mode === 'sketch') { sketcher.move(sx, sy); positionDyn(); return; }
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const item = pickAt(sx, sy, currentKinds());
    const before = App.hover ? selKey(App.hover) : '', after = item ? selKey(item) : '';
    if (before === after) return;
    const refsChanged = (App.hover && (App.hover.kind === 'region' || App.hover.kind === 'plane')) || (item && (item.kind === 'region' || item.kind === 'plane'));
    App.hover = item;
    if (refsChanged) drawReferences();
    applyHighlights();
  });
});
viewer.on('leave', () => { if (App.hover) { App.hover = null; drawReferences(); applyHighlights(); } });
viewer.on('click', (sx, sy, ev) => {
  closeMenus();
  if (App.mode === 'sketch') { sketcher.click(sx, sy, ev); return; }
  const item = pickAt(sx, sy, currentKinds());
  if (App.mode === 'dialog' && D && D.activeField) { if (item) dialogPick(item); return; }
  if (App.pendingSketch) {
    if (item && (item.kind === 'plane' || (item.kind === 'face' && item.info && item.info.type === 'PLANE'))) { App.pendingSketch = false; status(''); startSketch(planeRefOf(item)); }
    else toast('Pick a plane or a flat face to sketch on.');
    return;
  }
  if (!item) { if (!ev.shiftKey && !ev.ctrlKey) setSelection([]); return; }
  toggleSelect(item, ev.shiftKey || ev.ctrlKey);
});
viewer.on('dblclick', () => {
  if (App.mode !== 'idle') return;
  const s = App.selection[0];
  if (s && s.kind === 'region') { const f = App.doc.features.find((x) => x.id === s.sketch); if (f) editFeature(f); }
});
viewer.on('rightclick', (sx, sy, ev) => {
  if (App.mode === 'sketch') { if (!sketcher.escape()) finishSketch(true); return; }
  const item = pickAt(sx, sy, IDLE_KINDS);
  const sel = App.selection.length ? App.selection : item ? [item] : [];
  const planar = sel.find((s) => s.kind === 'plane' || (s.kind === 'face' && s.info && s.info.type === 'PLANE'));
  const partId = sel.find((s) => s.part) && sel.find((s) => s.part).part;
  showMenu(ev.clientX, ev.clientY, [
    planar ? { label: 'New sketch here', key: 'Shift+S', act: () => startSketch(planeRefOf(planar)) } : null,
    planar ? { label: 'View normal to', key: 'N', act: () => viewNormal(planar) } : null,
    partId ? { label: `Hide ${partName(partId)}`, act: () => setPartMeta(partId, { hidden: true }) } : null,
    partId ? { label: `Isolate ${partName(partId)}`, act: () => { for (const p of App.result.parts) setPartMeta(p.id, { hidden: p.id !== partId }, true); refreshScene(); } } : null,
    { label: 'Show all parts', act: () => { for (const p of App.result.parts) setPartMeta(p.id, { hidden: false }, true); refreshScene(); } },
    '-',
    { label: 'Zoom to fit', key: 'F', act: () => viewer.fit() },
    { label: 'Isometric', key: 'Shift+7', act: () => viewer.standardView('iso') },
    sel.length ? { label: 'Clear selection', key: 'Esc', act: () => setSelection([]) } : null,
  ]);
});

function planeRefOf(item) {
  if (item.kind === 'plane') return item.ref;
  const pl = planeOnFace(item.info.center, item.info.normal);
  return { kind: 'explicit', ...pl, face: { part: item.part, center: item.info.center, normal: item.info.normal } };
}
function viewNormal(item) {
  const pl = resolvePlane(App.doc, planeRefOf(item));
  viewer.setViewDir(new THREE.Vector3(...pl.normal), true, new THREE.Vector3(...planeY(pl)));
}
const partName = (id) => { const p = App.result.parts.find((x) => x.id === id); return p ? p.name : id; };
function setPartMeta(id, patch, quiet) {
  App.doc.partMeta[id] = { ...(App.doc.partMeta[id] || {}), ...patch };
  markDirty();
  if (patch.hidden !== undefined) viewer.setPartVisible(id, !patch.hidden);
  if (!quiet) { if (patch.color || patch.name) rebuild(); renderTree(); }
}

// ====================================================================== info / measure panel
function itemPoint(s) {
  if (s.kind === 'face') return s.info.center;
  if (s.kind === 'edge') return s.info.mid;
  if (s.kind === 'region') { const f = App.doc.features.find((x) => x.id === s.sketch); const r = f && findRegions(f.entities).regions[s.region]; return r ? toWorldOf(f, r.centroid) : null; }
  return null;
}
function toWorldOf(f, p) { const pl = resolvePlane(App.doc, f.plane); const y = planeY(pl); return [0, 1, 2].map((i) => pl.origin[i] + pl.x[i] * p[0] + y[i] * p[1]); }
function updateInfo() {
  const box = $('info');
  const sel = App.selection;
  const rows = [];
  const part = (id) => App.result.parts.find((p) => p.id === id);
  if (sel.length === 1) {
    const s = sel[0];
    if (s.kind === 'face') rows.push(['Face', `${prettyType(s.info.type)} on ${partName(s.part)}`], ['Area', `${fmt(s.info.area)} mm²`]);
    if (s.kind === 'face' && s.info.type === 'PLANE') rows.push(['Normal', s.info.normal.map((v) => fmt(v, 3)).join(', ')]);
    if (s.kind === 'edge') rows.push(['Edge', `${prettyType(s.info.type)} on ${partName(s.part)}`], ['Length', `${fmt(s.info.length)} mm`]);
    if (s.kind === 'part') { const p = part(s.part); if (p) rows.push(['Part', p.name], ['Volume', `${fmt(p.volume)} mm³`]); }
    if (s.kind === 'region') { const f = App.doc.features.find((x) => x.id === s.sketch); const r = f && findRegions(f.entities).regions[s.region]; if (r) rows.push(['Region', `${f.name}, region ${s.region + 1}`], ['Area', `${fmt(r.area)} mm²`]); }
    if (s.kind === 'plane') rows.push(['Plane', s.ref.name || (App.doc.features.find((f) => f.id === s.ref.id) || {}).name]);
  } else if (sel.length === 2) {
    const a = itemPoint(sel[0]), b = itemPoint(sel[1]);
    if (a && b) {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      rows.push(['Distance', `${fmt(Math.hypot(...d))} mm`], ['ΔX ΔY ΔZ', d.map((v) => fmt(v)).join(', ')]);
      if (sel.every((s) => s.kind === 'face' && s.info.type === 'PLANE') && Math.abs(Math.abs(dot(sel[0].info.normal, sel[1].info.normal)) - 1) < 1e-6) {
        rows.push(['Plane gap', `${fmt(Math.abs(dot(d, sel[0].info.normal)))} mm`]);
      }
    }
    const lens = sel.filter((s) => s.kind === 'edge').reduce((t, s) => t + s.info.length, 0);
    if (lens && sel.every((s) => s.kind === 'edge')) rows.push(['Total length', `${fmt(lens)} mm`]);
  } else if (sel.length > 2) {
    const areas = sel.filter((s) => s.kind === 'face').reduce((t, s) => t + s.info.area, 0);
    const lens = sel.filter((s) => s.kind === 'edge').reduce((t, s) => t + s.info.length, 0);
    rows.push(['Selected', `${sel.length} items`]);
    if (areas) rows.push(['Total area', `${fmt(areas)} mm²`]);
    if (lens) rows.push(['Total length', `${fmt(lens)} mm`]);
  }
  box.classList.toggle('hidden', !rows.length || App.mode === 'sketch');
  box.innerHTML = rows.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('');
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const prettyType = (t) => ({ PLANE: 'Plane', CYLINDRE: 'Cylinder', CYLINDER: 'Cylinder', CONE: 'Cone', SPHERE: 'Sphere', TORUS: 'Torus', BSPLINE_SURFACE: 'Spline surface', LINE: 'Line', CIRCLE: 'Circle', ELLIPSE: 'Ellipse', BSPLINE_CURVE: 'Spline' }[t] || (t ? t[0] + t.slice(1).toLowerCase() : ''));

// ====================================================================== feature tree
const FEATURE_ICONS = { sketch: 'sketch', extrude: 'extrude', revolve: 'revolve', fillet: 'fillet', chamfer: 'chamfer', shell: 'shell', plane: 'plane', pattern: 'linpattern', mirror: 'mirror', import: 'import' };
function renderTree() {
  const t = $('tree');
  const scroll = t.scrollTop;
  t.innerHTML = '';
  const n = App.doc.features.length;
  t.append(h('div', { cls: 'thead' }, `Features (${n})`));
  t.append(h('div', { cls: 'titem', title: 'Origin' }, h('span', { html: icon('origin', 16) }), h('span', { cls: 'tname' }, 'Origin')));
  for (const name of ['Top', 'Front', 'Right']) {
    const key = selKey({ kind: 'plane', ref: { kind: 'std', name } });
    const vis = App.doc.planes[name] !== false;
    const row = h('div', { cls: 'titem' + (App.selection.some((s) => selKey(s) === key) ? ' sel' : '') },
      h('span', { html: icon('plane', 16) }), h('span', { cls: 'tname' }, name),
      h('span', { cls: 'tvis', title: vis ? 'Hide' : 'Show', html: icon(vis ? 'eye' : 'eyeoff', 15), onclick: (e) => { e.stopPropagation(); App.doc.planes[name] = !vis; markDirty(); drawReferences(); renderTree(); } }));
    row.addEventListener('click', (e) => treePick({ kind: 'plane', ref: { kind: 'std', name } }, e));
    t.append(row);
  }
  for (const f of App.doc.features) {
    const st = App.result.status[f.id] || {};
    const cls = ['titem'];
    if (App.treeSel === f.id) cls.push('sel');
    if (st.ok === false) cls.push('err'); else if (st.warning) cls.push('warn');
    if (f.suppressed) cls.push('supp');
    const canHide = f.type === 'sketch' || f.type === 'plane';
    const row = h('div', { cls: cls.join(' '), title: st.error || st.warning || '' },
      h('span', { html: icon(FEATURE_ICONS[f.type] || 'part', 16) }),
      h('span', { cls: 'tname' }, f.name),
      st.ok === false ? h('span', { html: icon('error', 14) }) : st.warning ? h('span', { html: icon('warn', 14) }) : null,
      canHide ? h('span', { cls: 'tvis', title: f.hidden ? 'Show' : 'Hide', html: icon(f.hidden ? 'eyeoff' : 'eye', 15), onclick: (e) => { e.stopPropagation(); f.hidden = !f.hidden; markDirty(); drawReferences(); renderTree(); } }) : null);
    row.addEventListener('click', (e) => {
      if (App.mode === 'dialog' && D && D.activeField && D.activeField.kinds.includes('region') && f.type === 'sketch') {
        const regions = findRegions(f.entities).regions;
        regions.forEach((_, i) => dialogPick({ kind: 'region', sketch: f.id, region: i }, true));
        return;
      }
      if (f.type === 'plane') { App.treeSel = f.id; treePick({ kind: 'plane', ref: { kind: 'feature', id: f.id } }, e); return; }
      App.treeSel = f.id;
      renderTree();
    });
    row.addEventListener('dblclick', () => editFeature(f));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); App.treeSel = f.id; renderTree();
      showMenu(e.clientX, e.clientY, [
        { label: 'Edit...', act: () => editFeature(f) },
        { label: 'Rename...', act: () => renameFeature(f) },
        canHide ? { label: f.hidden ? 'Show' : 'Hide', act: () => { f.hidden = !f.hidden; markDirty(); drawReferences(); renderTree(); } } : null,
        { label: f.suppressed ? 'Unsuppress' : 'Suppress', act: () => commit(() => { f.suppressed = !f.suppressed; }) },
        '-',
        { label: 'Delete', key: 'Del', act: () => deleteFeature(f) },
      ]);
    });
    t.append(row);
  }
  t.append(h('div', { cls: 'thead', style: 'margin-top:10px' }, `Parts (${App.result.parts.length})`));
  for (const p of App.result.parts) {
    const meta = App.doc.partMeta[p.id] || {};
    const key = selKey({ kind: 'part', part: p.id });
    const row = h('div', { cls: 'titem' + (App.selection.some((s) => selKey(s) === key) ? ' sel' : '') },
      h('span', { cls: 'swatch', style: `background:${p.color}` }), h('span', { cls: 'tname' }, p.name),
      h('span', { cls: 'tvis', title: meta.hidden ? 'Show' : 'Hide', html: icon(meta.hidden ? 'eyeoff' : 'eye', 15), onclick: (e) => { e.stopPropagation(); setPartMeta(p.id, { hidden: !meta.hidden }); } }));
    row.addEventListener('click', (e) => treePick({ kind: 'part', part: p.id }, e));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Rename...', act: async () => { const v = await prompt1('Rename part', p.name); if (v) setPartMeta(p.id, { name: v }); } },
        { label: 'Change colour...', act: () => pickColor(p) },
        { label: meta.hidden ? 'Show' : 'Hide', act: () => setPartMeta(p.id, { hidden: !meta.hidden }) },
        '-',
        { label: 'Export STEP...', act: () => exportParts('step', [p.id]) },
        { label: 'Export STL...', act: () => exportParts('stl', [p.id]) },
      ]);
    });
    t.append(row);
  }
  if (App.lastBuildMs != null) t.append(h('div', { style: 'color:#9aa5b1;font-size:11px;padding:10px 14px' }, `Rebuilt in ${App.lastBuildMs} ms`));
  t.scrollTop = scroll;
}
function pickColor(p) {
  const inp = h('input', { type: 'color', value: p.color });
  inp.addEventListener('change', () => setPartMeta(p.id, { color: inp.value }));
  inp.click();
}

// ====================================================================== commands & undo
function snapshot() { return JSON.stringify(App.doc); }
function commit(fn) {
  App.undo.push(snapshot()); if (App.undo.length > 100) App.undo.shift();
  App.redo.length = 0;
  fn();
  markDirty();
  rebuild(); renderTree(); updateUndo();
}
App.commit = commit;
function undo() {
  if (App.mode !== 'idle') return;
  const s = App.undo.pop(); if (!s) return;
  App.redo.push(snapshot()); App.doc = JSON.parse(s); markDirty(); rebuild(); renderTree(); updateUndo();
}
function redo() {
  if (App.mode !== 'idle') return;
  const s = App.redo.pop(); if (!s) return;
  App.undo.push(snapshot()); App.doc = JSON.parse(s); markDirty(); rebuild(); renderTree(); updateUndo();
}
function updateUndo() { const u = $('btn-undo'), r = $('btn-redo'); if (u) u.disabled = !App.undo.length; if (r) r.disabled = !App.redo.length; }
function markDirty() { App.file.dirty = true; updateTitle(); }
function updateTitle() {
  const t = `${App.doc.name}${App.file.dirty ? ' *' : ''} - Partwright`;
  document.title = t;
  if (desk) desk.setTitle(t);
  if (document.activeElement !== $('docname')) $('docname').textContent = App.doc.name;
}
function nextName(type) {
  const base = { sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', plane: 'Plane', pattern: 'Pattern', mirror: 'Mirror', import: 'Import' }[type] || 'Feature';
  let i = 1; while (App.doc.features.some((f) => f.name === `${base} ${i}`)) i++;
  return `${base} ${i}`;
}
async function renameFeature(f) { const v = await prompt1('Rename feature', f.name); if (v) commit(() => { f.name = v; }); }
function deleteFeature(f) {
  const users = App.doc.features.filter((x) => x.sketch === f.id || (x.plane && x.plane.id === f.id) || (x.base && x.base.id === f.id));
  commit(() => { App.doc.features = App.doc.features.filter((x) => x !== f); });
  if (users.length) toast(`${users.map((u) => u.name).join(', ')} used ${f.name} and now need fixing.`, 'err');
  App.treeSel = null;
}

// ====================================================================== sketch mode
function startSketch(planeRef, existing) {
  if (App.mode !== 'idle') return;
  const f = existing || { id: newId('s'), type: 'sketch', name: nextName('sketch'), plane: planeRef, entities: [] };
  App.mode = 'sketch';
  App.sketchIsNew = !existing;
  App.viewBeforeSketch = viewer.quat.clone();
  setSelection([]);
  const pl = resolvePlane(App.doc, f.plane);
  sketcher.start(f, pl);
  drawReferences();
  viewer.setViewDir(new THREE.Vector3(...pl.normal), true, new THREE.Vector3(...planeY(pl)));
  $('sketchbar').classList.remove('hidden');
  buildSketchBar();
  sketchPanel();
  sketchStatus();
  updateInfo();
}
function buildSketchBar() {
  const bar = $('sketchbar');
  bar.innerHTML = '';
  bar.append(h('span', { cls: 'title' }, sketcher.feature.name));
  const tools = [['select', 'select', 'Select / move points (Esc)'], ['line', 'line', 'Line (L)'], ['rect', 'rect', 'Corner rectangle (R)'], ['crect', 'crect', 'Center rectangle (Shift+R)'], ['circle', 'circle', 'Circle (C)'], ['arc', 'arc', '3-point arc (A)'], ['point', 'point', 'Point (P)']];
  for (const [t, ic, tip] of tools) bar.append(h('button', { cls: 'iconbtn' + (sketcher.tool === t ? ' on' : ''), title: tip, html: icon(ic, 20), onclick: () => { sketcher.setTool(t); buildSketchBar(); } }));
  bar.append(h('span', { cls: 'sep' }));
  bar.append(h('button', { cls: 'iconbtn' + (sketcher.construction ? ' on' : ''), title: 'Construction (Q): toggles the selected entities, or the next ones you draw', html: icon('construction', 20), onclick: () => { sketcher.toggleConstruction(); buildSketchBar(); } }));
  bar.append(h('button', { cls: 'iconbtn', title: 'Delete selected (Del)', html: icon('trash', 20), onclick: () => sketcher.deleteSelected() }));
  bar.append(h('button', { cls: 'iconbtn', title: 'Undo in sketch (Ctrl+Z)', html: icon('undo', 20), onclick: () => sketcher.undo() }));
  bar.append(h('span', { cls: 'sep' }));
  bar.append(h('button', { cls: 'iconbtn', title: 'Finish sketch (Ctrl+Enter)', html: icon('check', 22), onclick: () => finishSketch(true) }));
  bar.append(h('button', { cls: 'iconbtn', title: 'Cancel sketch', html: icon('close', 20), onclick: () => finishSketch(false) }));
}
function sketchStatus() {
  if (App.mode !== 'sketch') return;
  const tips = { select: 'Click an entity to select it; click an end point to move it. Shift-click adds to the selection.', line: 'Click points to draw connected lines. Type a length and press Enter. Esc ends the chain.', rect: 'Click two corners, or type width,height.', crect: 'Click the centre then a corner, or type width,height.', circle: 'Click the centre then a point on the circle, or type the radius.', arc: 'Click the start, the end, then a point on the arc.', point: 'Click to place points.' };
  const info = sketcher.liveInfo();
  status(`${tips[sketcher.tool] || ''}${sketcher.construction ? '   [construction]' : ''}${info ? '   |   ' + info : ''}`);
  buildSketchBar();
}
function sketchPanel() {
  if (App.mode !== 'sketch') return;
  const d = $('dialog');
  d.classList.remove('hidden');
  d.innerHTML = '';
  const f = sketcher.feature;
  const { regions, openEnds } = findRegions(sketcher.entities);
  const body = h('div', { cls: 'dbody' },
    h('div', { cls: 'field' }, h('label', {}, 'Sketch name'), nameInput(f)),
    h('div', {}, `${sketcher.entities.length} entities, ${regions.length} closed region${regions.length === 1 ? '' : 's'}`),
    openEnds ? h('div', { cls: 'dmsg' }, `${openEnds} open end${openEnds === 1 ? '' : 's'}: only closed shapes can be extruded.`) : regions.length ? h('div', { cls: 'dmsg ok' }, 'Closed regions are shaded and ready to extrude.') : null,
    entityEditor());
  d.append(h('div', { cls: 'dhead' }, h('span', { html: icon('sketch', 18) }), h('span', { cls: 'dname' }, 'Sketch'),
    h('button', { cls: 'iconbtn', title: 'Finish', html: icon('check', 20), onclick: () => finishSketch(true) }),
    h('button', { cls: 'iconbtn', title: 'Cancel', html: icon('close', 18), onclick: () => finishSketch(false) })), body);
}
function nameInput(f) {
  const i = h('input', { type: 'text', value: f.name });
  i.addEventListener('change', () => { if (i.value.trim()) { f.name = i.value.trim(); buildSketchBar(); } });
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}
// numeric editing of the selected sketch entity
function entityEditor() {
  if (sketcher.selected.size !== 1) return h('div', { style: 'color:#6b7885;font-size:12px;line-height:1.5' }, 'Select one entity (Select tool) to edit its exact position and size here.');
  const e = sketcher.entities.find((x) => sketcher.selected.has(x.id));
  if (!e) return null;
  const rows = [];
  const num = (label, get, set) => {
    const inp = h('input', { value: fmt(get(), 4) });
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => { const v = evalNum(inp.value); if (v == null) { inp.value = fmt(get(), 4); return; } set(v); sketcher.record(); sketcher.redraw(); sketchPanel(); });
    rows.push(h('div', { cls: 'row' }, h('span', {}, label), inp));
  };
  if (e.type === 'line') {
    num('Start X', () => e.a[0], (v) => { e.a[0] = v; }); num('Start Y', () => e.a[1], (v) => { e.a[1] = v; });
    num('End X', () => e.b[0], (v) => { e.b[0] = v; }); num('End Y', () => e.b[1], (v) => { e.b[1] = v; });
    num('Length', () => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), (v) => { const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1; e.b = [e.a[0] + (e.b[0] - e.a[0]) / L * v, e.a[1] + (e.b[1] - e.a[1]) / L * v]; });
    num('Angle °', () => (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180 / Math.PI), (v) => { const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]); const a = v * Math.PI / 180; e.b = [e.a[0] + Math.cos(a) * L, e.a[1] + Math.sin(a) * L]; });
  } else if (e.type === 'circle' || e.type === 'arc') {
    num('Centre X', () => e.c[0], (v) => { e.c[0] = v; }); num('Centre Y', () => e.c[1], (v) => { e.c[1] = v; });
    num('Radius', () => e.r, (v) => { if (v > 0) e.r = v; }); num('Diameter', () => 2 * e.r, (v) => { if (v > 0) e.r = v / 2; });
    if (e.type === 'arc') { num('Start °', () => e.a1 * 180 / Math.PI, (v) => { e.a1 = v * Math.PI / 180; }); num('End °', () => e.a2 * 180 / Math.PI, (v) => { e.a2 = v * Math.PI / 180; }); }
  } else if (e.type === 'point') { num('X', () => e.p[0], (v) => { e.p[0] = v; }); num('Y', () => e.p[1], (v) => { e.p[1] = v; }); }
  const cb = h('input', { type: 'checkbox' }); cb.checked = !!e.construction;
  cb.addEventListener('change', () => { e.construction = cb.checked || undefined; sketcher.record(); sketcher.redraw(); });
  if (e.type !== 'point') rows.push(h('label', { cls: 'check' }, cb, 'Construction'));
  return h('div', { cls: 'sketchprops' }, h('div', { style: 'font-weight:600' }, { line: 'Line', circle: 'Circle', arc: 'Arc', point: 'Point' }[e.type]), rows);
}
function finishSketch(keep) {
  if (App.mode !== 'sketch') return;
  const f = sketcher.feature;
  const ents = sketcher.entities;
  sketcher.stop();
  App.mode = 'idle';
  $('sketchbar').classList.add('hidden'); $('dialog').classList.add('hidden'); hideDyn(); status('');
  if (keep) {
    commit(() => {
      if (App.sketchIsNew) App.doc.features.push({ ...f, entities: ents });
      else { const ex = App.doc.features.find((x) => x.id === f.id); if (ex) { ex.entities = ents; ex.name = f.name; } }
    });
    App.treeSel = f.id;
  } else drawReferences();
  // go back to the 3D view the user had before the sketch turned it face-on
  if (App.viewBeforeSketch) { viewer.animateTo(App.viewBeforeSketch, null, null); App.viewBeforeSketch = null; }
  renderTree(); updateInfo();
}

// typed values while sketching
function positionDyn() {
  const d = $('dyn');
  if (d.classList.contains('hidden') || !viewer.mouse) return;
  d.style.left = viewer.mouse[0] + 18 + 'px'; d.style.top = viewer.mouse[1] + 18 + 'px';
}
function showDyn(ch) {
  const d = $('dyn'), i = $('dyninput');
  d.classList.remove('hidden'); positionDyn();
  i.value = ch; i.focus();
}
function hideDyn() { const i = $('dyninput'); if (document.activeElement === i) i.blur(); $('dyn').classList.add('hidden'); i.value = ''; }
$('dyninput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = $('dyninput').value; hideDyn(); if (!sketcher.submitTyped(v)) toast('Type a length (e.g. 25), a size like 40,20, or a point like 10,5.'); sketchStatus();
    if (e.ctrlKey || e.metaKey) finishSketch(true);
  }
  if (e.key === 'Escape') hideDyn();
});

// ====================================================================== feature dialogs
let D = null; // active dialog state
const regionItems = (f) => {
  const sk = App.doc.features.find((x) => x.id === f.sketch);
  if (!sk) return [];
  const n = findRegions(sk.entities).regions.length;
  const idx = f.regions === 'all' ? [...Array(n).keys()] : (f.regions || []);
  return idx.map((i) => ({ kind: 'region', sketch: f.sketch, region: i }));
};
const regionField = { key: 'regions', label: 'Sketch regions', kinds: ['region'], multi: true,
  items: regionItems,
  set: (f, items) => { if (!items.length) { f.sketch = null; f.regions = []; return; } f.sketch = items[items.length - 1].sketch; f.regions = items.filter((i) => i.sketch === f.sketch).map((i) => i.region); } };
const opField = (allowIntersect = true) => ({ key: 'op', label: 'Result', type: 'choice', options: [['new', 'New'], ['add', 'Add'], ['remove', 'Remove'], ...(allowIntersect ? [['intersect', 'Intersect']] : [])] });
const edgeRef = (i) => {
  const r = { part: i.part, mid: i.info.mid, type: i.info.type };
  if (i.info.type === 'LINE') { const [a, b] = [i.info.start, i.info.end], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1; r.dir = [0, 1, 2].map((k) => (b[k] - a[k]) / l); }
  return r;
};
const edgeField = { key: 'edges', label: 'Edges', kinds: ['edge'], multi: true, items: (f) => (f.edges || []).map((r) => matchItem('edge', r)).filter(Boolean), set: (f, items) => { f.edges = items.map((i) => edgeRef(i)); } };
const partsField = { key: 'parts', label: 'Parts', kinds: ['part'], multi: true, items: (f) => (f.parts || []).map((id) => ({ kind: 'part', part: id })), set: (f, items) => { f.parts = [...new Set(items.map((i) => i.part))]; } };
const planeField = (key, label) => ({ key, label, kinds: ['plane', 'planarFace'], multi: false,
  items: (f) => (f[key] ? [planeItem(f[key])] : []),
  set: (f, items) => { f[key] = items.length ? planeRefOf(items[0]) : null; } });
function planeItem(ref) { return ref.kind === 'explicit' && ref.face ? { kind: 'plane', ref, label: 'Face plane' } : { kind: 'plane', ref }; }
// the same fallbacks the kernel uses when a referenced edge or face moved (see matchEdge/matchFace)
function segDist3(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], L = dot(ab, ab), t = L ? Math.max(0, Math.min(1, dot(ap, ab) / L)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}
function movedEdge(p, ref, tol) {
  if (!ref.dir) return null;
  const cands = p.edges.filter((e) => e.type === 'LINE' && (!ref.type || ref.type === 'LINE')).filter((e) => {
    const l = Math.hypot(e.end[0] - e.start[0], e.end[1] - e.start[1], e.end[2] - e.start[2]) || 1;
    return Math.abs(dot(ref.dir, [0, 1, 2].map((k) => (e.end[k] - e.start[k]) / l))) > 0.999;
  });
  let best = null, bd = Infinity;
  for (const e of cands) { const d = segDist3(ref.mid, e.start, e.end); if (d < bd) { bd = d; best = e; } }
  if (best && bd < tol * 10) return best;
  best = null; bd = Infinity;
  const size = Math.max(...p.edges.map((e) => Math.hypot(...e.mid)), 1);
  for (const e of cands) { const d = Math.hypot(e.mid[0] - ref.mid[0], e.mid[1] - ref.mid[1], e.mid[2] - ref.mid[2]); if (d < bd) { bd = d; best = e; } }
  return best && bd < 0.35 * size ? best : null;
}
function movedFace(p, ref, tol) {
  if (!ref.normal) return null;
  let best = null, bd = Infinity;
  for (const f of p.faces) {
    if (f.type !== 'PLANE' || dot(f.normal, ref.normal) < 0.999) continue;
    if (Math.abs(dot([0, 1, 2].map((k) => ref.center[k] - f.center[k]), f.normal)) > tol * 10) continue;
    const d = Math.hypot(f.center[0] - ref.center[0], f.center[1] - ref.center[1], f.center[2] - ref.center[2]);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
function matchItem(kind, ref) {
  const p = App.result.parts.find((x) => x.id === ref.part);
  if (!p) return { kind, part: ref.part, index: -1, info: kind === 'edge' ? { mid: ref.mid, type: '?', length: 0 } : { center: ref.center, normal: ref.normal, type: '?', area: 0 }, missing: true };
  const list = kind === 'edge' ? p.edges : p.faces;
  let best = null, bd = Infinity;
  for (const e of list) {
    const q = kind === 'edge' ? e.mid : e.center, r = kind === 'edge' ? ref.mid : ref.center;
    const d = Math.hypot(q[0] - r[0], q[1] - r[1], q[2] - r[2]);
    if (d < bd) { bd = d; best = e; }
  }
  const tol = 1e-3 * Math.max(1, Math.hypot(...(kind === 'edge' ? ref.mid : ref.center))) + 1e-6;
  if (!(best && bd < tol)) best = kind === 'edge' ? movedEdge(p, ref, tol) : movedFace(p, ref, tol);
  return best ? { kind, part: p.id, index: best.i, info: best } : { kind, part: p.id, index: -1, info: kind === 'edge' ? { mid: ref.mid } : { center: ref.center, normal: ref.normal }, missing: true };
}

const FEATURES = {
  extrude: { name: 'Extrude', icon: 'extrude', preview: true,
    init: () => ({ op: App.result.parts.length ? 'new' : 'new', mode: 'blind', depth: 10, flip: false, regions: [], sketch: null }),
    fields: [opField(), regionField,
      { key: 'mode', label: 'End type', type: 'choice', options: [['blind', 'Blind'], ['symmetric', 'Symmetric']] },
      { key: 'depth', label: 'Depth', type: 'number', unit: 'mm' }, { key: 'flip', label: 'Flip direction', type: 'check' }] },
  revolve: { name: 'Revolve', icon: 'revolve', preview: true,
    init: () => ({ op: 'new', axis: 'y', angle: 360, regions: [], sketch: null }),
    fields: [opField(), regionField,
      { key: 'axis', label: 'Axis', type: 'select', options: (f) => {
        const sk = App.doc.features.find((x) => x.id === f.sketch);
        const lines = ((sk && sk.entities) || []).filter((e) => e.type === 'line').map((e, i) => [`line:${e.id}`, `${e.construction ? 'Construction line' : 'Sketch line'} ${i + 1}`]);
        return [['y', 'Sketch vertical axis (Y)'], ['x', 'Sketch horizontal axis (X)'], ...lines];
      } },
      { key: 'angle', label: 'Angle', type: 'number', unit: '°' }] },
  fillet: { name: 'Fillet', icon: 'fillet', preview: false, init: () => ({ edges: [], size: 2 }), fields: [edgeField, { key: 'size', label: 'Radius', type: 'number', unit: 'mm' }] },
  chamfer: { name: 'Chamfer', icon: 'chamfer', preview: false, init: () => ({ edges: [], size: 1 }), fields: [edgeField, { key: 'size', label: 'Distance', type: 'number', unit: 'mm' }] },
  shell: { name: 'Shell', icon: 'shell', preview: false, init: () => ({ faces: [], thickness: 2 }),
    fields: [{ key: 'faces', label: 'Faces to remove', kinds: ['face'], multi: true, items: (f) => (f.faces || []).map((r) => matchItem('face', r)).filter(Boolean), set: (f, items) => { f.faces = items.map((i) => ({ part: i.part, center: i.info.center, normal: i.info.normal })); } },
      { key: 'thickness', label: 'Wall thickness', type: 'number', unit: 'mm' }] },
  plane: { name: 'Plane', icon: 'plane', preview: true, init: () => ({ base: { kind: 'std', name: 'Top' }, offset: 20 }), fields: [planeField('base', 'Reference plane or face'), { key: 'offset', label: 'Offset distance', type: 'number', unit: 'mm' }] },
  pattern: { name: 'Pattern', icon: 'linpattern', preview: true, init: () => ({ kind: 'linear', parts: [], axis: 'x', count: 3, spacing: 20, angle: 360, op: 'new' }),
    fields: [partsField, { key: 'kind', label: 'Pattern type', type: 'choice', options: [['linear', 'Linear'], ['circular', 'Circular']] },
      { key: 'axis', label: 'Direction / axis', type: 'choice', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']] },
      { key: 'count', label: 'Instance count', type: 'number', unit: '' },
      { key: 'spacing', label: 'Spacing', type: 'number', unit: 'mm', when: (f) => f.kind !== 'circular' },
      { key: 'angle', label: 'Total angle', type: 'number', unit: '°', when: (f) => f.kind === 'circular' },
      { key: 'op', label: 'Result', type: 'choice', options: [['new', 'New parts'], ['add', 'Merge']] }] },
  mirror: { name: 'Mirror', icon: 'mirror', preview: true, init: () => ({ parts: [], plane: { kind: 'std', name: 'Right' }, op: 'new' }),
    fields: [partsField, planeField('plane', 'Mirror plane'), { key: 'op', label: 'Result', type: 'choice', options: [['new', 'New parts'], ['add', 'Merge']] }] },
};

function openDialog(type, existing, presel = []) {
  if (App.mode === 'sketch') finishSketch(true);
  if (App.mode === 'dialog') closeDialog(false);
  const def = FEATURES[type];
  const isNew = !existing;
  const f = existing ? JSON.parse(JSON.stringify(existing)) : { id: newId('f'), type, name: nextName(type), ...def.init() };
  D = { def, f, isNew, index: isNew ? App.doc.features.length : App.doc.features.findIndex((x) => x.id === existing.id), activeField: null, msg: null };
  App.mode = 'dialog';
  // pre-selection
  const selFields = def.fields.filter((x) => x.kinds);
  for (const fld of selFields) {
    const items = presel.filter((s) => fld.kinds.includes(s.kind) || (fld.kinds.includes('planarFace') && s.kind === 'face' && s.info && s.info.type === 'PLANE') || (fld.kinds.includes('part') && s.part));
    const conv = fld.kinds.includes('part') ? items.map((s) => ({ kind: 'part', part: s.part })) : items;
    if (isNew && conv.length) fld.set(f, fld.multi ? conv : conv.slice(0, 1));
  }
  // extrude/revolve: default to the most recent sketch
  if (isNew && (type === 'extrude' || type === 'revolve') && !f.sketch) {
    const sk = App.doc.features.find((x) => x.id === App.treeSel && x.type === 'sketch') || [...App.doc.features].reverse().find((x) => x.type === 'sketch' && !x.suppressed);
    if (sk) { f.sketch = sk.id; f.regions = 'all'; if (sk.plane.kind === 'explicit') f.op = 'add'; }
  }
  D.activeField = selFields.find((x) => !x.items(f).length) || selFields[0] || null;
  App.selection = [];
  renderDialog();
  if (!def.preview && !isNew) previewDoc(true); else schedulePreview();
}
function editFeature(f) {
  if (f.type === 'sketch') { startSketch(f.plane, JSON.parse(JSON.stringify(f))); return; }
  if (f.type === 'import') { toast('Imported parts have no settings to edit.'); return; }
  if (!FEATURES[f.type]) return;
  openDialog(f.type, f);
}
App.openDialog = openDialog;
function renderDialog() {
  const d = $('dialog');
  d.classList.remove('hidden');
  d.innerHTML = '';
  const { def, f } = D;
  const body = h('div', { cls: 'dbody' });
  for (const fld of def.fields) {
    if (fld.when && !fld.when(f)) continue;
    if (fld.kinds) {
      const items = fld.items(f);
      const box = h('div', { cls: 'selbox' + (D.activeField === fld ? ' active' : ''), onclick: () => { D.activeField = fld; renderDialog(); refreshDialogHighlights(); } },
        items.length ? items.map((it, i) => h('span', { cls: 'chip' }, itemLabel(it), h('button', { title: 'Remove', onclick: (e) => { e.stopPropagation(); const all = fld.items(f); all.splice(i, 1); fld.set(f, all); changed(); } }, '×')))
          : h('span', { cls: 'empty' }, D.activeField === fld ? `Click ${kindText(fld.kinds)} in the view` : 'Click here, then select'));
      body.append(h('div', { cls: 'field' }, h('label', {}, fld.label), box));
    } else if (fld.type === 'number') {
      const inp = h('input', { type: 'text', value: f[fld.key] });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); inp.blur(); closeDialog(true); } if (e.key === 'Escape') closeDialog(false); });
      inp.addEventListener('input', () => { const v = evalNum(inp.value); if (v != null) { f[fld.key] = v; changed(false); } });
      inp.addEventListener('change', () => { inp.value = f[fld.key]; });
      body.append(h('div', { cls: 'field' }, h('label', {}, fld.label), h('div', { cls: 'unit' }, inp, h('span', {}, fld.unit))));
    } else if (fld.type === 'choice') {
      body.append(h('div', { cls: 'field' }, h('label', {}, fld.label), h('div', { cls: 'seg' }, fld.options.map(([v, l]) => h('button', { cls: f[fld.key] === v ? 'on' : '', onclick: () => { f[fld.key] = v; changed(); } }, l)))));
    } else if (fld.type === 'select') {
      const opts = fld.options(f);
      const sel = h('select', { style: 'width:100%;height:30px' }, opts.map(([v, l]) => h('option', { value: v }, l)));
      sel.value = f[fld.key];
      sel.addEventListener('change', () => { f[fld.key] = sel.value; changed(); });
      body.append(h('div', { cls: 'field' }, h('label', {}, fld.label), sel));
    } else if (fld.type === 'check') {
      const cb = h('input', { type: 'checkbox' }); cb.checked = !!f[fld.key];
      cb.addEventListener('change', () => { f[fld.key] = cb.checked; changed(); });
      body.append(h('label', { cls: 'check' }, cb, fld.label));
    }
  }
  if (D.msg) body.append(h('div', { cls: 'dmsg' + (D.msg.ok ? ' ok' : '') }, D.msg.text));
  if (!def.preview) body.append(h('div', { style: 'color:#6b7885;font-size:12px' }, 'The result appears when you press the green check.'));
  d.append(h('div', { cls: 'dhead' }, h('span', { html: icon(def.icon, 18) }), h('span', { cls: 'dname' }, D.isNew ? def.name : `${def.name}: ${f.name}`),
    h('button', { cls: 'iconbtn', title: 'Accept (Enter)', html: icon('check', 20), onclick: () => closeDialog(true) }),
    h('button', { cls: 'iconbtn', title: 'Cancel (Esc)', html: icon('close', 18), onclick: () => closeDialog(false) })), body);
  refreshDialogHighlights();
}
const kindText = (k) => k.map((x) => ({ region: 'sketch regions', edge: 'edges', face: 'faces', part: 'parts', plane: 'a plane', planarFace: 'a flat face' }[x])).join(' or ');
function itemLabel(it) {
  if (it.kind === 'region') { const f = App.doc.features.find((x) => x.id === it.sketch); return `${f ? f.name : 'Sketch'} region ${it.region + 1}`; }
  if (it.kind === 'edge') return it.missing ? 'Edge (missing)' : `${prettyType(it.info.type)} edge`;
  if (it.kind === 'face') return it.missing ? 'Face (missing)' : `${prettyType(it.info.type)} face`;
  if (it.kind === 'part') return partName(it.part);
  if (it.kind === 'plane') return it.ref.kind === 'std' ? it.ref.name : it.ref.kind === 'feature' ? ((App.doc.features.find((x) => x.id === it.ref.id) || {}).name || 'Plane') : 'Face plane';
  return it.kind;
}
function dialogPick(item, addOnly) {
  const fld = D.activeField;
  if (!fld) return;
  let it = item;
  if (fld.kinds.includes('part') && item.part) it = { kind: 'part', part: item.part };
  if (fld.kinds.includes('planarFace') && item.kind === 'face' && !(item.info && item.info.type === 'PLANE')) { toast('Pick a flat face or a plane.'); return; }
  const items = fld.items(D.f);
  const k = selKey(it);
  const idx = items.findIndex((x) => selKey(x) === k);
  if (idx >= 0) { if (!addOnly) items.splice(idx, 1); }
  else if (fld.multi) items.push(it);
  else items.splice(0, items.length, it);
  fld.set(D.f, items);
  changed();
}
function refreshDialogHighlights() {
  if (!D) return;
  const sel = [];
  for (const fld of D.def.fields) if (fld.kinds) sel.push(...fld.items(D.f).filter((i) => !i.missing));
  App.selection = sel;
  drawReferences(); applyHighlights();
}
function changed(rerender = true) {
  if (rerender) renderDialog(); else refreshDialogHighlights();
  if (D.def.preview) schedulePreview();
}
let previewTimer = 0, previewSeq = 0;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(() => previewDoc(false), 140); }
async function previewDoc(baseOnly) {
  if (!D) return;
  const seq = ++previewSeq;
  const feats = App.doc.features.slice(0, D.index);
  if (!baseOnly) feats.push(D.f);
  const doc = { ...App.doc, features: feats };
  busy(true);
  const r = await call('rebuild', { doc, preview: true });
  busy(false);
  if (!D || seq !== previewSeq || r.superseded || !r.ok) return;
  if (!baseOnly) {
    const st = r.status[D.f.id];
    const prevMsg = D.msg && D.msg.text;
    D.msg = st && st.ok === false ? { text: st.error } : st && st.warning ? { text: st.warning } : null;
    if ((D.msg && D.msg.text) !== prevMsg) renderDialog();
  }
  D.previewParts = r.parts;
  refreshScene(r.parts);
  refreshDialogHighlights();
}
function closeDialog(accept) {
  if (!D) return;
  const { f, isNew, index, def } = D;
  if (accept) {
    const bad = def.fields.find((fld) => fld.kinds && !fld.items(f).length && !(fld.key === 'regions' && f.sketch));
    if (bad) { toast(`Select ${kindText(bad.kinds)} first.`, 'err'); return; }
  }
  D = null; App.mode = 'idle';
  $('dialog').classList.add('hidden');
  App.selection = [];
  if (accept) {
    commit(() => { if (isNew) App.doc.features.push(f); else App.doc.features[index] = f; });
    App.treeSel = f.id;
  } else { refreshScene(); }
  renderTree(); updateInfo();
}

// ====================================================================== tools / toolbar
const TOOLS = [
  { id: 'sketch', label: 'Sketch', icon: 'sketch', key: 'Shift+S', run: () => toolSketch() },
  '-',
  { id: 'extrude', label: 'Extrude', icon: 'extrude', key: 'Shift+E', run: () => openDialog('extrude', null, App.selection) },
  { id: 'revolve', label: 'Revolve', icon: 'revolve', key: 'Shift+W', run: () => openDialog('revolve', null, App.selection) },
  { id: 'fillet', label: 'Fillet', icon: 'fillet', key: 'Shift+F', run: () => openDialog('fillet', null, App.selection) },
  { id: 'chamfer', label: 'Chamfer', icon: 'chamfer', key: 'Shift+C', run: () => openDialog('chamfer', null, App.selection) },
  { id: 'shell', label: 'Shell', icon: 'shell', key: 'Shift+L', run: () => openDialog('shell', null, App.selection) },
  '-',
  { id: 'plane', label: 'Plane', icon: 'plane', key: 'Shift+P', run: () => openDialog('plane', null, App.selection) },
  { id: 'linpattern', label: 'Linear pattern', icon: 'linpattern', run: () => openDialog('pattern', null, App.selection) },
  { id: 'circpattern', label: 'Circular pattern', icon: 'circpattern', run: () => { openDialog('pattern', null, App.selection); D.f.kind = 'circular'; D.f.axis = 'z'; D.f.count = 6; changed(); } },
  { id: 'mirror', label: 'Mirror', icon: 'mirror', run: () => openDialog('mirror', null, App.selection) },
  '-',
  { id: 'section', label: 'Section view', icon: 'section', run: () => sectionPanel() },
  { id: 'import', label: 'Import STEP / STL', icon: 'import', run: () => importFile() },
  { id: 'exportstep', label: 'Export STEP', icon: 'export', run: () => exportParts('step') },
  { id: 'exportstl', label: 'Export STL', icon: 'export', run: () => exportParts('stl') },
];
function toolSketch() {
  const s = App.selection.find((x) => x.kind === 'plane' || (x.kind === 'face' && x.info && x.info.type === 'PLANE'));
  if (s) { startSketch(planeRefOf(s)); return; }
  App.pendingSketch = true;
  setSelection([]);
  status('Select a plane (Top, Front, Right) or a flat face to sketch on.');
  toast('Pick a plane or a flat face to sketch on.');
}
function buildToolbar() {
  const tb = $('toolbar');
  tb.innerHTML = '';
  for (const t of TOOLS) {
    if (t === '-') { tb.append(h('span', { cls: 'sep' })); continue; }
    const b = h('button', { cls: 'iconbtn', id: `tool-${t.id}`, title: `${t.label}${t.key ? ` (${t.key})` : ''}`, html: icon(t.icon, 22), onclick: () => { closeMenus(); t.run(); } });
    tb.append(b);
  }
  const search = h('input', { id: 'toolsearch', placeholder: 'Search tools...', spellcheck: 'false' });
  tb.append(search);
  let list = null, sel = 0, hits = [];
  const close = () => { if (list) { list.remove(); list = null; } };
  const draw = () => {
    close();
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    hits = TOOLS.filter((t) => t !== '-' && t.label.toLowerCase().includes(q));
    if (!hits.length) return;
    const r = search.getBoundingClientRect();
    list = h('div', { cls: 'searchlist', style: `left:${r.left}px;top:${r.bottom + 4}px` }, hits.map((t, i) => h('div', { cls: i === sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); search.value = ''; close(); t.run(); } }, h('span', { html: icon(t.icon, 18) }), t.label)));
    document.body.append(list);
  };
  search.addEventListener('input', () => { sel = 0; draw(); });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { sel = Math.min(hits.length - 1, sel + 1); draw(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); }
    if (e.key === 'Enter' && hits[sel]) { const t = hits[sel]; search.value = ''; close(); search.blur(); t.run(); }
    if (e.key === 'Escape') { search.value = ''; close(); search.blur(); }
  });
  search.addEventListener('blur', () => setTimeout(close, 100));
}
function buildTopbar() {
  $('brand').innerHTML = `${icon('logo', 24)}<span>Partwright</span>`;
  const fb = $('filebtns');
  const btn = (id, ic, tip, fn) => h('button', { cls: 'iconbtn', id, title: tip, html: icon(ic, 19), onclick: fn });
  fb.append(btn('btn-new', 'newdoc', 'New (Ctrl+N)', () => fileNew()), btn('btn-open', 'open', 'Open (Ctrl+O)', () => fileOpen()), btn('btn-save', 'save', 'Save (Ctrl+S)', () => fileSave()),
    h('span', { style: 'width:10px' }), btn('btn-undo', 'undo', 'Undo (Ctrl+Z)', () => undo()), btn('btn-redo', 'redo', 'Redo (Ctrl+Y)', () => redo()),
    h('span', { style: 'width:10px' }), btn('btn-image', 'image', 'Save image (PNG)', () => saveImage()));
  $('helpbtn').innerHTML = icon('help', 20);
  $('helpbtn').onclick = () => showHelp();
  const dn = $('docname');
  dn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); dn.blur(); } });
  dn.addEventListener('blur', () => { const v = dn.textContent.trim() || 'Untitled'; if (v !== App.doc.name) { App.doc.name = v; markDirty(); } dn.textContent = App.doc.name; });
  updateUndo();
}
function buildViewTools() {
  const vt = $('viewtools');
  const btn = (ic, tip, fn) => h('button', { cls: 'iconbtn', title: tip, html: icon(ic, 20), onclick: fn });
  vt.append(btn('fit', 'Zoom to fit (F)', () => viewer.fit()),
    btn('views', 'Named views', (e) => showMenu(e.clientX - 160, e.clientY, [['Front', 'front', 'Shift+1'], ['Back', 'back', 'Shift+2'], ['Left', 'left', 'Shift+3'], ['Right', 'right', 'Shift+4'], ['Top', 'top', 'Shift+5'], ['Bottom', 'bottom', 'Shift+6'], ['Isometric', 'iso', 'Shift+7']].map(([l, v, k]) => ({ label: l, key: k, act: () => viewer.standardView(v) })))),
    btn('shaded', 'Display mode', (e) => showMenu(e.clientX - 180, e.clientY, [['Shaded with edges', 'shadedEdges'], ['Shaded', 'shaded'], ['Translucent', 'translucent'], ['Wireframe', 'wireframe']].map(([l, m]) => ({ label: (viewer.mode === m ? '✓ ' : '   ') + l, act: () => viewer.setMode(m) })))),
    btn('section', 'Section view', () => sectionPanel()));
}

// ====================================================================== section view
let sectionState = null;
function sectionPanel() {
  const size = modelSize();
  const st = sectionState || { plane: 'Front', offset: 0, flip: false, on: false };
  const apply = () => {
    sectionState = st;
    if (!st.on) { viewer.setSection(null); return; }
    const n = { Front: [0, 1, 0], Top: [0, 0, -1], Right: [-1, 0, 0] }[st.plane].map((v) => v * (st.flip ? -1 : 1));
    const nv = new THREE.Vector3(...n);
    // keep the half the normal points into; the plane passes through offset along the reference axis
    const axis = { Front: new THREE.Vector3(0, 1, 0), Top: new THREE.Vector3(0, 0, 1), Right: new THREE.Vector3(1, 0, 0) }[st.plane];
    const point = axis.clone().multiplyScalar(st.offset);
    viewer.setSection(new THREE.Plane().setFromNormalAndCoplanarPoint(nv, point));
    drawReferences();
  };
  st.on = true; apply();
  const slider = h('input', { type: 'range', min: -size, max: size, step: size / 400, value: st.offset, style: 'width:100%' });
  const num = h('input', { type: 'text', value: fmt(st.offset), style: 'width:90px;height:28px' });
  slider.addEventListener('input', () => { st.offset = +slider.value; num.value = fmt(st.offset); apply(); });
  num.addEventListener('keydown', (e) => e.stopPropagation());
  num.addEventListener('change', () => { const v = evalNum(num.value); if (v != null) { st.offset = v; slider.value = v; apply(); } });
  const seg = h('div', { cls: 'seg' }, ['Front', 'Top', 'Right'].map((p) => h('button', { cls: st.plane === p ? 'on' : '', onclick: (e) => { st.plane = p; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); apply(); } }, p)));
  const flip = h('input', { type: 'checkbox' }); flip.checked = st.flip;
  flip.addEventListener('change', () => { st.flip = flip.checked; apply(); });
  modal('Section view', h('div', { style: 'display:flex;flex-direction:column;gap:12px;width:360px' },
    h('div', {}, 'Cut the parts with a plane to look inside. Cut faces are filled.'),
    h('div', {}, h('div', { style: 'color:#6b7885;margin-bottom:4px' }, 'Cutting plane'), seg),
    h('div', {}, h('div', { style: 'color:#6b7885;margin-bottom:4px' }, 'Offset (mm)'), h('div', { style: 'display:flex;gap:8px;align-items:center' }, slider, num)),
    h('label', { cls: 'check' }, flip, 'Show the other side')),
  [{ label: 'Turn off', act: () => { st.on = false; apply(); } }, { label: 'Keep section', primary: true }], { backdrop: false });
}

// ====================================================================== files
const DOC_FILTERS = [{ name: 'Partwright document (*.pwd)', extensions: ['pwd'] }];
async function confirmDiscard() {
  if (!App.file.dirty || !App.doc.features.length) return true;
  const r = await modal('Unsaved changes', h('div', {}, `Save changes to "${App.doc.name}"?`), [{ label: 'Save', primary: true, value: 'save' }, { label: "Don't save", value: 'discard' }, { label: 'Cancel', value: 'cancel' }]);
  if (r === 'save') return fileSave();
  return r === 'discard';
}
async function fileNew() {
  if (!(await confirmDiscard())) return;
  App.doc = newDoc(); App.file = { path: null, dirty: false }; App.undo = []; App.redo = []; App.selection = []; App.treeSel = null;
  updateTitle(); await rebuild(); viewer.standardView('iso'); viewer.fit();
}
function loadDoc(text, path) {
  const d = JSON.parse(text);
  if (!d || d.format !== 'Partwright' || !Array.isArray(d.features)) throw new Error('This is not a Partwright document.');
  App.doc = { ...newDoc(), ...d, partMeta: d.partMeta || {}, planes: { Top: true, Front: true, Right: true, ...(d.planes || {}) } };
  App.file = { path: path || null, dirty: false }; App.undo = []; App.redo = []; App.selection = []; App.treeSel = null;
  updateTitle();
  return rebuild().then(() => viewer.fit());
}
App.loadDoc = loadDoc;
async function fileOpen() {
  if (!(await confirmDiscard())) return;
  try {
    const f = await openFile([...DOC_FILTERS], false);
    if (f) await loadDoc(f.data, f.path);
  } catch (err) { toast(`Could not open: ${err.message}`, 'err'); }
}
async function fileSave(as) {
  const data = JSON.stringify(App.doc, null, 1);
  const name = `${App.doc.name.replace(/[\\/:*?"<>|]+/g, '_')}.pwd`;
  try {
    let path = App.file.path;
    if (!path || as || !desk) { path = await saveFile(name, DOC_FILTERS, data); if (!path) return false; }
    else await desk.writeFile(path, data);
    App.file = { path: desk ? path : null, dirty: false };
    updateTitle(); toast('Saved.');
    return true;
  } catch (err) { toast(`Save failed: ${err.message}`, 'err'); return false; }
}
async function importFile() {
  try {
    const f = await openFile([{ name: 'STEP or STL (*.step, *.stp, *.stl)', extensions: ['step', 'stp', 'stl'] }], 'auto');
    if (!f) return;
    const isStl = /\.stl$/i.test(f.name);
    commit(() => App.doc.features.push({ id: newId('i'), type: 'import', name: `Import ${f.name}`, format: isStl ? 'stl' : 'step', data: f.data }));
    App.emit = (ev) => { if (ev === 'rebuilt') { App.emit = null; viewer.fit(); } };
  } catch (err) { toast(`Import failed: ${err.message}`, 'err'); }
}
async function exportParts(format, ids) {
  const sel = ids || [...new Set(App.selection.filter((s) => s.part).map((s) => s.part))];
  if (!App.result.parts.length) { toast('There is nothing to export yet.'); return; }
  busy(true);
  const r = await call('export', { format, ids: sel });
  busy(false);
  if (!r.ok) { toast(r.error, 'err'); return; }
  const name = `${App.doc.name.replace(/[\\/:*?"<>|]+/g, '_')}.${format === 'stl' ? 'stl' : 'step'}`;
  const filters = format === 'stl' ? [{ name: 'STL (*.stl)', extensions: ['stl'] }] : [{ name: 'STEP (*.step)', extensions: ['step', 'stp'] }];
  const path = await saveFile(name, filters, r.data);
  if (path) toast(`Exported ${sel.length ? sel.length + ' part(s)' : 'all parts'} to ${path.split(/[\\/]/).pop()}.`);
}
async function saveImage() {
  const url = viewer.snapshot();
  const b64 = url.split(',')[1];
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const p = await saveFile(`${App.doc.name}.png`, [{ name: 'PNG image', extensions: ['png'] }], bin.buffer);
  if (p) toast('Image saved.');
}
// desktop / browser file helpers. data: string or ArrayBuffer
async function openFile(filters, binary) {
  if (desk) return desk.openFile(filters, binary);
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept: filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',') });
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return res(null);
      const isBin = binary === true || (binary === 'auto' && /\.stl$/i.test(file.name));
      if (isBin) { const buf = new Uint8Array(await file.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); res({ name: file.name, data: btoa(s) }); }
      else res({ name: file.name, data: await file.text() });
    };
    inp.click();
  });
}
async function saveFile(name, filters, data) {
  if (desk) {
    const p = await desk.saveDialog(name, filters);
    if (!p) return null;
    await desk.writeFile(p, data);
    return p;
  }
  const a = h('a', { href: URL.createObjectURL(new Blob([data])), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return name;
}

// ====================================================================== UI helpers
function status(t) { $('status').textContent = t || ''; }
function toast(text, kind) {
  const el = h('div', { cls: 'toast' + (kind ? ' ' + kind : '') }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
}
App.toast = toast;
let openMenu = null;
function closeMenus() { if (openMenu) { openMenu.remove(); openMenu = null; } }
function showMenu(x, y, items) {
  closeMenus();
  const m = h('div', { cls: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div', { cls: 'sep' })); continue; }
    m.append(h('div', { cls: 'mi', onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); closeMenus(); it.act(); } }, h('span', {}, it.label), it.key ? h('span', { cls: 'k' }, it.key) : null));
  }
  $('menus').append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenu = m;
}
window.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenus(); });
function modal(title, body, buttons, opts = {}) {
  return new Promise((res) => {
    const bg = h('div', { cls: 'modal-bg', style: opts.backdrop === false ? 'background:transparent;pointer-events:none' : '' });
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey, true); res(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(undefined); } };
    document.addEventListener('keydown', onKey, true);
    const box = h('div', { cls: 'modal', style: opts.backdrop === false ? 'pointer-events:auto;position:fixed;right:160px;top:120px' : '' },
      h('div', { cls: 'mh' }, title), h('div', { cls: 'mb' }, body),
      h('div', { cls: 'mf' }, buttons.map((b) => h('button', { cls: 'btn' + (b.primary ? ' primary' : ''), onclick: () => { if (b.act) b.act(); close(b.value); } }, b.label))));
    bg.append(box);
    $('modals').append(bg);
    const first = box.querySelector('input'); if (first && opts.focus !== false) setTimeout(() => first.focus(), 0);
  });
}
App.modal = modal;
async function prompt1(title, value) {
  const inp = h('input', { type: 'text', value, style: 'width:320px;height:30px;padding:0 8px' });
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.closest('.modal').querySelector('.btn.primary').click(); });
  const ok = await modal(title, inp, [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }]);
  return ok ? inp.value.trim() : null;
}
// numbers may be simple arithmetic: 20*2, 100/3+5
function evalNum(s) {
  const t = String(s).trim();
  if (!/^[\d\s+\-*/().]+$/.test(t)) return null;
  const tok = t.match(/\d*\.?\d+(?:e[+-]?\d+)?|[+\-*/()]/gi) || [];
  let i = 0;
  const atom = () => {
    const k = tok[i++];
    if (k === '-') return -atom();
    if (k === '+') return atom();
    if (k === '(') { const v = sum(); if (tok[i++] !== ')') throw 0; return v; }
    const v = parseFloat(k); if (!Number.isFinite(v)) throw 0; return v;
  };
  const prod = () => { let v = atom(); while (tok[i] === '*' || tok[i] === '/') v = tok[i++] === '*' ? v * atom() : v / atom(); return v; };
  const sum = () => { let v = prod(); while (tok[i] === '+' || tok[i] === '-') v = tok[i++] === '+' ? v + prod() : v - prod(); return v; };
  try { const v = sum(); return i === tok.length && Number.isFinite(v) ? v : null; } catch (_) { return null; }
}
function showHelp() {
  const rows = [
    ['h', 'Mouse'], ['Right drag', 'Rotate the view'], ['Middle drag  /  Ctrl + right drag', 'Pan'], ['Wheel', 'Zoom at the cursor'], ['Click', 'Select a face, edge, sketch region or plane'], ['Shift / Ctrl + click', 'Add to the selection'], ['Right click', 'Context menu'],
    ['h', 'Modelling'], ['Shift+S', 'Sketch on the selected plane or flat face'], ['Shift+E', 'Extrude'], ['Shift+W', 'Revolve'], ['Shift+F', 'Fillet'], ['Shift+C', 'Chamfer'], ['Shift+L', 'Shell'], ['Shift+P', 'Plane'], ['Double-click a feature', 'Edit it'], ['Delete', 'Delete the selected feature'],
    ['h', 'Sketching'], ['L / R / Shift+R / C / A / P', 'Line, rectangle, centre rectangle, circle, arc, point'], ['Type a number', 'Exact length or radius (Enter to apply); 40,20 for a rectangle'], ['Q', 'Construction geometry'], ['Esc', 'End the current shape, then select tool'], ['Ctrl+Enter', 'Finish the sketch'],
    ['h', 'View'], ['F', 'Zoom to fit'], ['N', 'View normal to the selected face or plane'], ['Shift+1 ... Shift+7', 'Front, Back, Left, Right, Top, Bottom, Isometric'],
    ['h', 'Files'], ['Ctrl+N / Ctrl+O / Ctrl+S', 'New, open, save (.pwd)'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ];
  const g = h('div', { cls: 'keys', style: 'width:600px' });
  for (const [k, d] of rows) { if (k === 'h') g.append(h('div', { cls: 'h' }, d)); else g.append(h('div', { cls: 'k' }, k), h('div', {}, d)); }
  modal('Partwright - help', g, [{ label: 'Close', primary: true }]);
}

// ====================================================================== keyboard
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-bg:not([style*="transparent"])')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === 'F1') { e.preventDefault(); showHelp(); return; }
  if (App.mode === 'sketch') {
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); sketcher.undo(); return; }
    if (ctrl && k === 'Enter') { e.preventDefault(); finishSketch(true); return; }
    if (k === 'Escape') { e.preventDefault(); if (!sketcher.escape()) finishSketch(true); buildSketchBar(); sketchStatus(); return; }
    if (k === 'Enter') { e.preventDefault(); sketcher.reset(); sketcher.redraw(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); sketcher.deleteSelected(); return; }
    if (!ctrl && !e.altKey) {
      if (/^[0-9.\-]$/.test(k) && sketcher.tool !== 'select') { e.preventDefault(); showDyn(k); return; }
      const map = { l: 'line', r: e.shiftKey ? 'crect' : 'rect', c: 'circle', a: 'arc', p: 'point', s: 'select' };
      if (map[k.toLowerCase()]) { e.preventDefault(); sketcher.setTool(map[k.toLowerCase()]); buildSketchBar(); return; }
      if (k.toLowerCase() === 'q') { e.preventDefault(); sketcher.toggleConstruction(); buildSketchBar(); sketchStatus(); return; }
    }
    return;
  }
  if (App.mode === 'dialog') {
    if (k === 'Escape') { e.preventDefault(); closeDialog(false); }
    if (k === 'Enter') { e.preventDefault(); closeDialog(true); }
    return;
  }
  if (ctrl) {
    const key = k.toLowerCase();
    if (key === 'z') { e.preventDefault(); undo(); } else if (key === 'y') { e.preventDefault(); redo(); }
    else if (key === 's') { e.preventDefault(); fileSave(e.shiftKey); } else if (key === 'o') { e.preventDefault(); fileOpen(); } else if (key === 'n') { e.preventDefault(); fileNew(); }
    return;
  }
  if (e.shiftKey && /^Digit[1-7]$/.test(e.code)) { e.preventDefault(); viewer.standardView(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'][+e.code.slice(5) - 1]); return; }
  if (e.shiftKey) {
    const tool = TOOLS.find((x) => x !== '-' && x.key === `Shift+${k.toUpperCase()}`);
    if (tool) { e.preventDefault(); tool.run(); return; }
  }
  if (k === 'Escape') { App.pendingSketch = false; status(''); setSelection([]); return; }
  if (k.toLowerCase() === 'f') { viewer.fit(); return; }
  if (k.toLowerCase() === 'n') { const s = App.selection.find((x) => x.kind === 'plane' || (x.kind === 'face' && x.info.type === 'PLANE')); if (s) viewNormal(s); return; }
  if (k === 'Delete') { const f = App.doc.features.find((x) => x.id === App.treeSel); if (f) deleteFeature(f); }
});

// ====================================================================== desktop integration & boot
if (desk) {
  desk.onMenu(async (cmd) => {
    const map = { NEW: fileNew, OPEN: fileOpen, SAVE: () => fileSave(), SAVEAS: () => fileSave(true), IMPORT: importFile, EXPORTSTEP: () => exportParts('step'), EXPORTSTL: () => exportParts('stl'), UNDO: undo, REDO: redo, HELP: showHelp, FIT: () => viewer.fit() };
    if (cmd === 'APP_CLOSE') { if (await confirmDiscard()) desk.reallyClose(); return; }
    if (map[cmd]) map[cmd]();
  });
  desk.onFileOpened(async (f) => { try { if (/\.(step|stp|stl)$/i.test(f.name)) { commit(() => App.doc.features.push({ id: newId('i'), type: 'import', name: `Import ${f.name}`, format: /\.stl$/i.test(f.name) ? 'stl' : 'step', data: f.data })); } else await loadDoc(f.data, f.path); } catch (err) { toast(err.message, 'err'); } });
}
window.addEventListener('beforeunload', (e) => { if (!desk && App.file.dirty && App.doc.features.length) { e.preventDefault(); e.returnValue = ''; } });

buildTopbar(); buildToolbar(); buildViewTools();
updateTitle();
renderTree();
busy(true);
call('init').then((r) => {
  busy(false);
  if (!r.ok) { toast(`The modelling engine failed to start: ${r.error}`, 'err'); return; }
  App.ready = true;
  rebuild().then(() => { viewer.standardView('iso'); viewer.fit(false); drawReferences(); });
});
