// Shared end-to-end modelling flow, driven with real mouse and keyboard input.
// Works against a browser page or an Electron window.
import assert from 'node:assert/strict';

export async function runFlow(page, shots) {
  const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/${n}.png` }); };
  await page.waitForFunction(() => window.App && window.App.ready && window.App.result, null, { timeout: 90000 });
  const vp = await page.locator('#viewport').boundingBox();
  const idle = async () => { await page.waitForTimeout(150); await page.waitForFunction(() => document.querySelector('#busy').classList.contains('hidden'), null, { timeout: 60000 }); };
  const toScreen = (p) => page.evaluate((p) => { return window.App.viewer.worldToScreen(window.App.viewer.camera.position.clone().set(...p)); }, p);

  // 1. Sketch a 60 x 40 rectangle on the Top plane, typed exactly.
  await page.locator('.titem', { hasText: 'Top' }).first().click();
  await page.keyboard.press('Shift+S');
  await page.waitForFunction(() => window.App.mode === 'sketch');
  await page.waitForTimeout(500);
  await page.keyboard.press('r');
  const [ox, oy] = await toScreen([0, 0, 0]);
  await page.mouse.move(vp.x + ox, vp.y + oy); await page.mouse.click(vp.x + ox, vp.y + oy);
  await page.keyboard.type('60,40'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  // and a circle hole inside it
  await page.keyboard.press('c');
  const [cx, cy] = await toScreen([30, 20, 0]);
  await page.mouse.move(vp.x + cx, vp.y + cy); await page.mouse.click(vp.x + cx, vp.y + cy);
  await page.keyboard.type('8'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const ents = await page.evaluate(() => window.App.sketcher.entities.map((e) => e.type));
  assert.deepEqual(ents.sort(), ['circle', 'line', 'line', 'line', 'line'], 'sketch entities: ' + ents);
  await shot('1-sketch');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.App.mode === 'idle');

  // 2. Extrude it 25 mm.
  await page.keyboard.press('Shift+E');
  await page.waitForFunction(() => window.App.mode === 'dialog');
  await page.waitForTimeout(300);
  await shot('2-extrude-dialog');
  await page.locator('#dialog .field', { hasText: 'Depth' }).locator('input').fill('25');
  await page.locator('#dialog .field', { hasText: 'Depth' }).locator('input').press('Enter');
  await page.waitForFunction(() => window.App.mode === 'idle');
  await idle();
  let parts = await page.evaluate(() => window.App.result.parts.map((p) => p.volume));
  assert.equal(parts.length, 1, 'one part');
  assert.ok(Math.abs(parts[0] - (60 * 40 - Math.PI * 64) * 25) < 1, 'volume ' + parts[0]);
  await page.keyboard.press('Shift+Digit7'); await page.waitForTimeout(450);
  await page.keyboard.press('f'); await page.waitForTimeout(500);
  await shot('3-extruded');

  // 3. Fillet a vertical corner edge by clicking it.
  await page.keyboard.press('Shift+F');
  await page.waitForFunction(() => window.App.mode === 'dialog');
  const [ex, ey] = await toScreen([60, 0, 12.5]);
  await page.mouse.move(vp.x + ex, vp.y + ey); await page.waitForTimeout(100);
  await page.mouse.click(vp.x + ex, vp.y + ey);
  await page.locator('#dialog .field', { hasText: 'Radius' }).locator('input').fill('6');
  await page.waitForTimeout(200);
  const chips = await page.locator('#dialog .chip').count();
  assert.equal(chips, 1, 'one edge selected');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.App.mode === 'idle');
  await idle();
  parts = await page.evaluate(() => window.App.result.parts.map((p) => p.volume));
  const removed = (36 - Math.PI * 9) * 25;
  assert.ok(Math.abs(parts[0] - ((60 * 40 - Math.PI * 64) * 25 - removed)) < 2, 'fillet volume ' + parts[0]);
  await shot('4-fillet');

  // 4. Edit the extrude depth from the feature tree; the fillet must follow.
  await page.locator('.titem', { hasText: 'Extrude 1' }).dblclick();
  await page.waitForFunction(() => window.App.mode === 'dialog');
  await page.locator('#dialog .field', { hasText: 'Depth' }).locator('input').fill('40');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.App.mode === 'idle');
  await idle();
  const status = await page.evaluate(() => window.App.result.status);
  parts = await page.evaluate(() => window.App.result.parts.map((p) => p.volume));
  assert.ok(Math.abs(parts[0] - ((60 * 40 - Math.PI * 64) * 40 - (36 - Math.PI * 9) * 40)) < 3, 'rebuilt volume ' + parts[0] + ' ' + JSON.stringify(status));
  await page.keyboard.press('f'); await page.waitForTimeout(500);
  await shot('5-edited');

  // 5. Undo / redo
  await page.keyboard.press('Control+z'); await idle();
  parts = await page.evaluate(() => window.App.result.parts.map((p) => p.volume));
  assert.ok(Math.abs(parts[0] - ((60 * 40 - Math.PI * 64) * 25 - removed)) < 2, 'undo volume ' + parts[0]);
  await page.keyboard.press('Control+y'); await idle();
  return { features: await page.evaluate(() => window.App.doc.features.map((f) => f.type)) };
}
