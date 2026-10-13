// 3D viewport: camera, controls, part display, picking, highlights, view cube, section view.
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const Z_UP = new THREE.Vector3(0, 0, 1);

export class Viewer {
  constructor(host, cubeHost) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camera.up.copy(Z_UP);
    this.target = new THREE.Vector3(0, 0, 0);
    this.viewHeight = 200;
    this.quat = new THREE.Quaternion();
    this.w = 1; this.h = 1;
    // lighting follows the camera
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.55); this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.55); this.scene.add(this.key); this.scene.add(this.key.target);
    this.groups = { parts: new THREE.Group(), sketches: new THREE.Group(), planes: new THREE.Group(), overlay: new THREE.Group(), section: new THREE.Group() };
    for (const g of Object.values(this.groups)) this.scene.add(g);
    this.parts = new Map(); // id -> { data, mesh, edges, group }
    this.mode = 'shadedEdges';
    this.clip = null; // THREE.Plane when section view is on
    this.hover = null; this.selection = [];
    this.listeners = {};
    this.edgeMats = [];
    this.setViewDir(new THREE.Vector3(1, -1, 0.8).normalize(), false);
    this.initCube(cubeHost);
    this.initControls();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.loop();
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => f(...a)); }

  // ------------------------------------------------------------ camera
  resize() {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.renderer.setSize(this.w, this.h);
    for (const m of this.edgeMats) m.resolution.set(this.w, this.h);
    this.updateCamera();
  }
  updateCamera() {
    const aspect = this.w / this.h, hh = this.viewHeight / 2;
    Object.assign(this.camera, { left: -hh * aspect, right: hh * aspect, top: hh, bottom: -hh });
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    this.camera.position.copy(this.target).addScaledVector(back, 5000);
    this.camera.quaternion.copy(this.quat);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.key.position.copy(this.camera.position).add(new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat).multiplyScalar(0)).add(new THREE.Vector3(-0.4, 0.6, 0).applyQuaternion(this.quat).multiplyScalar(3000));
    this.key.target.position.copy(this.target);
    this.dirty = true;
  }
  // look along -dir (dir points from target to camera); keep Z up where possible
  setViewDir(dir, animate = true, upHint) {
    const z = dir.clone().normalize();
    let up = upHint ? upHint.clone() : Z_UP.clone();
    if (Math.abs(z.dot(up)) > 0.999) up = new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    if (!animate) { this.quat.copy(q); this.updateCamera(); return; }
    this.animateTo(q, null, null);
  }
  animateTo(q, target, height) {
    const q0 = this.quat.clone(), t0 = this.target.clone(), h0 = this.viewHeight, start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 320), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.quat.slerpQuaternions(q0, q, e);
      if (target) this.target.lerpVectors(t0, target, e);
      if (height) this.viewHeight = h0 + (height - h0) * e;
      this.updateCamera();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }
  standardView(name) {
    const v = { front: [0, -1, 0], back: [0, 1, 0], top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], iso: [1, -1, 0.82] }[name];
    if (v) this.setViewDir(new THREE.Vector3(...v));
  }
  fit(animate = true) {
    const box = new THREE.Box3();
    for (const p of this.parts.values()) if (p.group.visible) box.expandByObject(p.mesh);
    for (const o of this.groups.sketches.children) if (o.visible) box.expandByObject(o);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    const c = box.getCenter(new THREE.Vector3());
    // fit the box's projection on screen
    const inv = this.quat.clone().invert();
    const pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z).sub(c).applyQuaternion(inv));
    const w = Math.max(...pts.map((p) => Math.abs(p.x))) * 2, hgt = Math.max(...pts.map((p) => Math.abs(p.y))) * 2;
    const height = Math.max(hgt, w * this.h / this.w) * 1.25 || 100;
    if (animate) this.animateTo(this.quat.clone(), c, height);
    else { this.target.copy(c); this.viewHeight = height; this.updateCamera(); }
  }
  // world point under a screen position on the plane through the target facing the camera
  screenToRay(sx, sy) {
    const ndc = new THREE.Vector2((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray;
  }
  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    return [(p.x + 1) / 2 * this.w, (1 - p.y) / 2 * this.h];
  }
  pixelSize() { return this.viewHeight / this.h; }

  initControls() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      drag = { b: e.button, x: e.clientX, y: e.clientY, sx: e.clientX - r.left, sy: e.clientY - r.top, moved: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      this.mouse = [sx, sy];
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.moved && (drag.b === 2 && !drag.ctrl)) this.orbit(dx, dy);
        else if (drag.moved && (drag.b === 1 || (drag.b === 2 && drag.ctrl))) this.pan(dx, dy);
        else if (drag.moved && drag.b === 0 && this.leftDragOrbit) this.orbit(dx, dy);
      }
      if (!drag || !drag.moved) this.emit('hover', sx, sy, e);
    });
    el.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved) this.emit(d.b === 0 ? 'click' : d.b === 2 ? 'rightclick' : 'middleclick', d.sx, d.sy, e);
    });
    el.addEventListener('dblclick', (e) => { const r = el.getBoundingClientRect(); this.emit('dblclick', e.clientX - r.left, e.clientY - r.top, e); });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    el.addEventListener('pointerleave', () => this.emit('leave'));
  }
  orbit(dx, dy) {
    const qz = new THREE.Quaternion().setFromAxisAngle(Z_UP, -dx * 0.008);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
    const qx = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.008);
    this.quat.premultiply(qx).premultiply(qz).normalize();
    this.updateCamera();
  }
  pan(dx, dy) {
    const s = this.pixelSize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    this.updateCamera();
  }
  zoomAt(sx, sy, f) {
    const s = this.pixelSize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    const ox = (sx - this.w / 2) * s, oy = -(sy - this.h / 2) * s;
    this.target.addScaledVector(right, ox * (1 - f)).addScaledVector(up, oy * (1 - f));
    this.viewHeight = Math.min(1e6, Math.max(1e-3, this.viewHeight * f));
    this.updateCamera();
  }

  // ------------------------------------------------------------ parts
  setParts(list, opts = {}) {
    for (const p of this.parts.values()) { this.groups.parts.remove(p.group); disposeTree(p.group); }
    this.parts.clear();
    for (const d of list) {
      if (d.error || !d.vertices) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.vertices, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
      g.setIndex(new THREE.BufferAttribute(d.triangles, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const color = new THREE.Color(d.color || '#c9cfd6');
      const mat = new THREE.MeshPhongMaterial({ color, specular: 0x333333, shininess: 40, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: !!opts.preview, opacity: opts.preview ? 0.7 : 1 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.partId = d.id;
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(d.lines, 3));
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1b1f24 }));
      const group = new THREE.Group();
      group.add(mesh, edges);
      group.visible = !d.hidden;
      this.groups.parts.add(group);
      this.parts.set(d.id, { data: d, mesh, edges, group, mat });
    }
    this.applyMode(); this.applyClip();
    this.clearHighlights(); this.dirty = true;
  }
  setPartVisible(id, v) { const p = this.parts.get(id); if (p) { p.group.visible = v; p.data.hidden = !v; this.applyClip(); this.dirty = true; } }
  setMode(mode) { this.mode = mode; this.applyMode(); }
  applyMode() {
    for (const p of this.parts.values()) {
      p.mesh.visible = this.mode !== 'wireframe';
      p.edges.visible = this.mode !== 'shaded';
      p.mat.transparent = this.mode === 'translucent' || p.mat.opacity < 1;
      if (this.mode === 'translucent') p.mat.opacity = 0.45; else if (p.mat.opacity === 0.45) p.mat.opacity = 1;
      p.mat.depthWrite = this.mode !== 'translucent';
      p.mat.needsUpdate = true;
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ section view with capped cuts
  setSection(plane) {
    this.clip = plane; // THREE.Plane or null; keeps the side the normal points away from
    this.applyClip();
  }
  applyClip() {
    for (const c of [...this.groups.section.children]) { this.groups.section.remove(c); disposeTree(c); }
    const planes = this.clip ? [this.clip] : [];
    for (const p of this.parts.values()) { p.mat.clippingPlanes = planes; p.edges.material.clippingPlanes = planes; p.mat.needsUpdate = true; }
    for (const o of this.groups.sketches.children) o.traverse((m) => { if (m.material) { m.material.clippingPlanes = planes; } });
    if (!this.clip) { this.dirty = true; return; }
    let order = 1;
    for (const p of this.parts.values()) {
      if (!p.group.visible) continue;
      const geo = p.mesh.geometry;
      const base = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, clippingPlanes: planes });
      const back = base.clone(); back.side = THREE.BackSide; back.stencilFail = back.stencilZFail = back.stencilZPass = THREE.IncrementWrapStencilOp;
      const front = base.clone(); front.side = THREE.FrontSide; front.stencilFail = front.stencilZFail = front.stencilZPass = THREE.DecrementWrapStencilOp;
      const mb = new THREE.Mesh(geo, back), mf = new THREE.Mesh(geo, front);
      mb.userData.sharedGeometry = mf.userData.sharedGeometry = true;
      mb.renderOrder = mf.renderOrder = order;
      const capColor = new THREE.Color(p.mat.color).lerp(new THREE.Color('#ffd28a'), 0.45);
      const capMat = new THREE.MeshPhongMaterial({ color: capColor, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp, side: THREE.DoubleSide });
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
      const sphere = geo.boundingSphere;
      const size = sphere.radius * 4 + 1;
      cap.scale.set(size, size, 1);
      // place the cap on the clipping plane, centred near the part
      const centre = this.clip.projectPoint(sphere.center.clone(), new THREE.Vector3());
      cap.position.copy(centre);
      cap.lookAt(centre.clone().sub(this.clip.normal));
      cap.renderOrder = order + 0.1;
      cap.onAfterRender = (r) => r.clearStencil();
      this.groups.section.add(mb, mf, cap);
      order++;
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ picking
  pick(sx, sy, kinds) {
    const res = [];
    const ray = this.screenToRay(sx, sy);
    const visibleParts = [...this.parts.values()].filter((p) => p.group.visible && p.mesh.visible !== false);
    // edges first (screen-space distance), they sit on top of faces
    if (kinds.edge) {
      // every edge segment near the cursor, nearest first; take the first one not hidden behind a face
      const near = new Map(); // "part/edge" -> { d, part, edge, point }
      for (const p of visibleParts) {
        const pos = p.data.lines;
        for (const g of p.data.edgeGroups) {
          for (let k = g.start; k < g.start + g.count; k += 2) {
            const A = new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]), B = new THREE.Vector3(pos[k * 3 + 3], pos[k * 3 + 4], pos[k * 3 + 5]);
            const a = this.worldToScreen(A), b = this.worldToScreen(B);
            const t = segParam([sx, sy], a, b);
            const d = Math.hypot(sx - a[0] - (b[0] - a[0]) * t, sy - a[1] - (b[1] - a[1]) * t);
            if (d >= 7) continue;
            const point = A.clone().lerp(B, t);
            if (this.clip && this.clip.distanceToPoint(point) < -1e-6) continue;
            const key = p.data.id + '/' + g.edgeId, prev = near.get(key);
            if (!prev || d < prev.d) near.set(key, { d, part: p.data.id, edge: g.edgeId, point });
          }
        }
      }
      const cands = [...near.values()].sort((x, y) => x.d - y.d);
      if (cands.length) {
        const hit = this.raycastParts(ray, visibleParts)[0];
        const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
        const seeThrough = this.mode === 'wireframe' || this.mode === 'translucent';
        const c = cands.find((x) => seeThrough || !hit || x.point.clone().sub(ray.ray.origin).dot(camDir) <= hit.distance + this.pixelSize() * 4);
        if (c) res.push({ kind: 'edge', part: c.part, index: c.edge, info: this.parts.get(c.part).data.edges[c.edge] });
      }
    }
    if (kinds.face || kinds.part) {
      const hit = this.raycastParts(ray, visibleParts)[0];
      if (hit) {
        const p = this.parts.get(hit.object.userData.partId);
        const tri = hit.faceIndex * 3;
        const g = p.data.faceGroups.find((x) => tri >= x.start && tri < x.start + x.count);
        if (g && kinds.face) res.push({ kind: 'face', part: p.data.id, index: g.faceId, info: p.data.faces[g.faceId], point: hit.point });
        if (kinds.part) res.push({ kind: 'part', part: p.data.id, point: hit.point });
      }
    }
    return res;
  }
  raycastParts(ray, list) {
    const hits = ray.intersectObjects(list.map((p) => p.mesh), false);
    return this.clip ? hits.filter((h) => this.clip.distanceToPoint(h.point) >= -1e-9) : hits;
  }

  // ------------------------------------------------------------ highlights
  clearHighlights() {
    for (const c of [...this.groups.overlay.children]) { this.groups.overlay.remove(c); disposeTree(c); }
    this.edgeMats = [];
    this.dirty = true;
  }
  highlight(items, color, width = 3) {
    for (const it of items) {
      const p = this.parts.get(it.part);
      if (!p) continue;
      if (it.kind === 'face') {
        const g = p.data.faceGroups.find((x) => x.faceId === it.index);
        if (!g) continue;
        const idx = p.data.triangles.slice(g.start, g.start + g.count);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', p.mesh.geometry.getAttribute('position'));
        geo.setAttribute('normal', p.mesh.geometry.getAttribute('normal'));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide, clippingPlanes: this.clip ? [this.clip] : [] }));
        m.userData.sharedGeometry = true; // shares the part's vertex buffers
        m.renderOrder = 50;
        this.groups.overlay.add(m);
      } else if (it.kind === 'edge') {
        const g = p.data.edgeGroups.find((x) => x.edgeId === it.index);
        if (!g) continue;
        const seg = p.data.lines.slice(g.start * 3, (g.start + g.count) * 3);
        const geo = new LineSegmentsGeometry().setPositions(seg);
        const mat = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true });
        mat.resolution.set(this.w, this.h);
        this.edgeMats.push(mat);
        const l = new LineSegments2(geo, mat);
        l.renderOrder = 60;
        this.groups.overlay.add(l);
      } else if (it.kind === 'part') {
        const g = p.mesh.geometry;
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: this.clip ? [this.clip] : [] }));
        m.userData.sharedGeometry = true;
        m.renderOrder = 50;
        this.groups.overlay.add(m);
      }
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ view cube
  initCube(host) {
    this.cubeHost = host;
    this.cubeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.cubeRenderer.setPixelRatio(window.devicePixelRatio || 1);
    this.cubeRenderer.setSize(120, 120);
    host.appendChild(this.cubeRenderer.domElement);
    this.cubeScene = new THREE.Scene();
    this.cubeCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, -10, 10);
    this.cubeScene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const label = (t) => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#f4f6f8'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#9aa5b1'; g.lineWidth = 4; g.strokeRect(2, 2, 124, 124);
      g.fillStyle = '#33404d'; g.font = '600 26px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t, 64, 64);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: tex });
    };
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    const names = ['Right', 'Left', 'Back', 'Front', 'Top', 'Bottom'];
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), names.map(label));
    this.cube.userData.names = names;
    this.cubeScene.add(this.cube);
    const axis = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.85, -0.85, -0.85), new THREE.Vector3(-0.85, -0.85, -0.85).add(dir.clone().multiplyScalar(2.3))]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    };
    this.cubeScene.add(axis(new THREE.Vector3(1, 0, 0), 0xd23b3b), axis(new THREE.Vector3(0, 1, 0), 0x2f9e44), axis(new THREE.Vector3(0, 0, 1), 0x2f6fd2));
    const el = this.cubeRenderer.domElement;
    el.addEventListener('click', (e) => {
      const r = el.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.cubeCam);
      const hit = ray.intersectObject(this.cube)[0];
      if (!hit) return;
      // clicking near a corner or edge gives the corresponding diagonal view
      const p = hit.point.clone().divideScalar(0.85);
      const dir = new THREE.Vector3(Math.abs(p.x) > 0.7 ? Math.sign(p.x) : 0, Math.abs(p.y) > 0.7 ? Math.sign(p.y) : 0, Math.abs(p.z) > 0.7 ? Math.sign(p.z) : 0);
      if (dir.lengthSq() === 0) dir.copy(hit.face.normal);
      this.setViewDir(dir);
    });
  }
  renderCube() {
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    this.cubeCam.position.copy(back.multiplyScalar(5));
    this.cubeCam.quaternion.copy(this.quat);
    this.cubeCam.updateMatrixWorld();
    this.cubeRenderer.render(this.cubeScene, this.cubeCam);
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.renderCube();
  }
  render() { this.dirty = true; }
  snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

function segParam(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  return L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
}
export function disposeTree(o) {
  o.traverse((c) => {
    if (c.geometry && !c.userData.sharedGeometry) c.geometry.dispose();
    if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
  });
}
export { THREE };
