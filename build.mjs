// Bundles the renderer and the modelling worker into build/ for Electron (or a static web server).
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const out = 'build';
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', sourcemap: true, logLevel: 'warning',
  // the OpenCascade loader has Node-only branches that never run in the browser
  external: ['fs', 'path', 'module', 'url', 'crypto', 'worker_threads', 'perf_hooks', 'node:*'] };
await esbuild.build({ ...common, entryPoints: ['src/ui/main.js'], outfile: `${out}/app.js` });
await esbuild.build({ ...common, entryPoints: ['src/kernel/worker.js'], outfile: `${out}/worker.js` });
fs.copyFileSync('node_modules/replicad-opencascadejs/dist/replicad_single.wasm', `${out}/replicad_single.wasm`);
for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join('src/ui', f), path.join(out, f));
console.log('built', fs.readdirSync(out).map((f) => `${f} ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)}K`).join(', '));
