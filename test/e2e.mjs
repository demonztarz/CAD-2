// End-to-end test: launches the real Electron app and models a part through the UI.
// Run with: npm run test:e2e   (on Linux CI wrap it in xvfb-run)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { runFlow } from './flow.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.E2E_SHOTS || null;
const app = await electron.launch({ args: [root, '--no-sandbox'], cwd: root });
let failed = false;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  const r = await runFlow(page, shots);
  assert.deepEqual(r.features, ['sketch', 'extrude', 'fillet']);

  // export STEP through the same IPC the save dialog uses
  const out = path.join(os.tmpdir(), `partwright-e2e-${process.pid}.step`);
  const ok = await page.evaluate(async (out) => {
    const r = await window.App.call('export', { format: 'step', ids: [] });
    if (!r.ok) return r.error;
    await window.desktop.writeFile(out, r.data);
    return true;
  }, out);
  assert.equal(ok, true);
  assert.ok(fs.readFileSync(out, 'utf8').startsWith('ISO-10303-21'), 'STEP file written');
  fs.unlinkSync(out);
  assert.deepEqual(errors, [], 'no page errors');
  console.log('e2e passed');
} catch (e) {
  failed = true;
  console.error('e2e FAILED:', e.stack || e);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
