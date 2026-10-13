// Modelling worker: runs OpenCascade off the UI thread.
import opencascade from 'replicad-opencascadejs';
import * as R from 'replicad';
import { evaluate, tessellate, exportParts } from './model.js';

let ready = null;
let lastParts = new Map();
const queue = [];
let busy = false;

function init(wasmUrl) {
  if (!ready) {
    ready = (async () => {
      const OC = await opencascade({ locateFile: () => wasmUrl });
      R.setOC(OC);
    })();
  }
  return ready;
}

async function handle(msg) {
  const { id, cmd } = msg;
  try {
    await init(msg.wasmUrl || self.__wasmUrl);
    if (cmd === 'init') return post({ id, ok: true });
    if (cmd === 'rebuild') {
      const t0 = performance.now();
      const { parts, status } = await evaluate(R, msg.doc, msg.upTo);
      const out = [];
      const transfer = [];
      for (const p of parts.values()) {
        try {
          const t = tessellate(R, p, msg.quality || 1);
          out.push(t);
          transfer.push(t.vertices.buffer, t.normals.buffer, t.triangles.buffer, t.lines.buffer);
        } catch (err) {
          out.push({ id: p.id, name: p.name, color: p.color, error: String(err && err.message || err) });
        }
      }
      if (!msg.preview) { for (const p of lastParts.values()) safeDelete(p.shape); lastParts = parts; }
      else for (const p of parts.values()) safeDelete(p.shape);
      return post({ id, ok: true, parts: out, status, ms: Math.round(performance.now() - t0) }, transfer);
    }
    if (cmd === 'export') {
      const blob = exportParts(R, lastParts, msg.ids, msg.format);
      const buf = await blob.arrayBuffer();
      return post({ id, ok: true, data: buf }, [buf]);
    }
    throw new Error(`Unknown command ${cmd}`);
  } catch (err) {
    post({ id, ok: false, error: String((err && err.message) || err) });
  }
}
function safeDelete(shape) { try { if (shape && shape.delete) shape.delete(); } catch (_) { /* already freed */ } }
function post(m, transfer) { self.postMessage(m, transfer || []); }

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const msg = queue.shift();
    // a newer full rebuild supersedes an older one still waiting
    if (msg.cmd === 'rebuild' && !msg.preview && queue.some((m) => m.cmd === 'rebuild' && !m.preview)) { post({ id: msg.id, ok: false, superseded: true }); continue; }
    if (msg.cmd === 'rebuild' && msg.preview && queue.some((m) => m.cmd === 'rebuild')) { post({ id: msg.id, ok: false, superseded: true }); continue; }
    await handle(msg);
  }
  busy = false;
}
self.onmessage = (ev) => {
  if (ev.data && ev.data.cmd === 'config') { self.__wasmUrl = ev.data.wasmUrl; return; }
  queue.push(ev.data);
  pump();
};
