import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, model, video, webview } from './page';

test('comparison composites the reference with the shown frame, and the host keeps the pin', async () => {
  const w = await webview('preview', { width: 900, height: 700 }), { page } = w;
  try {
    const pixel = (x: number) => page.locator('.compare-canvas').evaluate((c: HTMLCanvasElement, x) =>
      [...c.getContext('2d')!.getImageData(Math.floor(c.width * x), Math.floor(c.height / 2), 1, 1).data], x);
    const pins = async () => (await w.messages()).filter(m => m.kind === 'pin').map(m => m.id);
    const red = await frame(page, 1.25, '#ff0000'), blue = await frame(page, 1.5, '#0000ff');
    await w.publish(model({ time: 1.25, frame: red }));
    await page.waitForFunction(() => !!document.querySelector('.media-stage img') && !(document.querySelector('.media-stage img') as HTMLElement).style.visibility);
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Measure', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await pins(), [red.id]);
    await w.publish(model({ time: 1.25, frame: red, reference: red }));
    await w.send({ kind: 'seek', time: 1.5 });
    assert.equal((await w.message('frameNeeded')).time, 1.5);
    await w.publish(model({ time: 1.5, frame: blue, reference: red }));
    await page.waitForFunction(() => !document.querySelector('.compare-canvas')!.hasAttribute('hidden'));
    assert.deepEqual(await pixel(.25), [255, 0, 0, 255]); assert.deepEqual(await pixel(.75), [0, 0, 255, 255]);
    assert.match(await page.locator('.compare-labels').innerText(), /Reference: 1.25 s.*Current: 1.50 s/);
    await page.getByRole('button', { name: 'Overlay', exact: true }).click();
    assert.equal((await page.evaluate(() => (window as any).savedState)).compareMode, 'overlay');
    const blend = await pixel(.25);
    assert.ok(Math.abs(blend[0] - 127) <= 1 && blend[1] === 0 && Math.abs(blend[2] - 128) <= 1, `50% blend: ${blend}`);
    await page.getByLabel('Current frame opacity').focus(); await page.keyboard.press('Home');
    assert.deepEqual(await pixel(.75), [255, 0, 0, 255]);
    await page.getByRole('button', { name: 'Wipe', exact: true }).click();
    const divider = page.getByRole('slider', { name: 'Wipe divider', exact: true });
    await divider.focus(); await page.keyboard.press('Home'); assert.deepEqual(await pixel(.25), [0, 0, 255, 255]);
    const count = (await w.messages()).length;
    await page.keyboard.press('ArrowLeft');
    assert.equal((await w.messages()).length, count, 'divider arrows do not move the preview');
    await page.getByLabel('Wipe position', { exact: true }).fill('50');
    const bounds = (await page.locator('.compare-canvas').boundingBox())!;
    await divider.hover(); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height / 2); await page.mouse.up();
    assert.ok(Math.abs(Number(await divider.getAttribute('aria-valuenow')) - 25) <= 1);
    // Off and on again keeps the reference; Replace reference pins the shown frame.
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    assert.equal(await page.locator('.compare-canvas').isVisible(), false);
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    assert.deepEqual(await pixel(.1), [255, 0, 0, 255]);
    assert.deepEqual(await pins(), [red.id]);
    await page.getByRole('button', { name: 'Replace reference', exact: true }).click();
    assert.deepEqual(await pins(), [red.id, blue.id]);
    // An outdated current frame and a reference that does not load keep their pixels.
    await w.publish(model({ time: 1.5, frame: { ...blue, outdated: true }, reference: red, job: undefined, timelineOutdated: true }));
    assert.match(await page.locator('.compare-labels').innerText(), /Current: 1.50 s.*Outdated/);
    assert.equal(await page.locator('.watermark').innerText(), 'OUTDATED');
    await page.route('https://cue.test/broken.png', route => route.fulfill({ status: 404, body: '' }));
    await w.publish(model({ time: 1.5, frame: { ...blue, outdated: true }, reference: { ...blue, id: 'broken', uri: 'https://cue.test/broken.png' }, job: undefined }));
    await page.waitForFunction(() => document.querySelector('.compare-info')?.textContent?.includes('did not load'));
    assert.deepEqual(await pixel(.1), [255, 0, 0, 255]);
    // A frame of another size.
    const uri = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 200; c.getContext('2d')!.fillRect(0, 0, 200, 200); return c.toDataURL(); });
    const square = { ...await frame(page, 2, '#000', { time: null }), uri };
    await w.send({ kind: 'seek', time: 2 });
    await w.publish(model({ time: 2, frame: square, reference: red }));
    await page.waitForFunction(() => document.querySelector('.compare-info')?.textContent?.includes('different sizes'));
    assert.match(await page.locator('.compare-labels').innerText(), /Current: last frame/);
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    assert.equal(await page.locator('.compare-canvas').isVisible(), false, 'Measure ends the comparison');
    // Another scene ends the comparison.
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await w.publish(model({ scene: 'Other', sceneKey: 'file:///other.py#Other', time: 0 }));
    assert.equal(await page.getByRole('button', { name: 'Compare', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});

test('comparison from a video pins a new frame at the video position', async () => {
  const w = await webview('preview'), { page } = w;
  try {
    await w.publish(model({ time: .5, video: video() }));
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.style.visibility; });
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    assert.equal((await w.message('frameNeeded')).time, .5, 'the video is not a reference: a frame is');
    assert.match(await page.locator('.compare-info').innerText(), /Updating frame/);
    assert.equal(await page.locator('video').isVisible(), true, 'the video stays until the frame is there');
    const still = await frame(page, .5);
    await w.publish(model({ time: .5, video: video(), frame: still }));
    assert.equal((await w.message('pin')).id, still.id);
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});
