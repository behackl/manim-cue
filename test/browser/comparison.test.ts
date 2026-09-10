import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Model } from '../../src/protocol';

test('comparison composites exact endpoints, keeps reference through updates and decode races, and supports accessible controls', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    const stateApi = 'window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>window.savedState,setState:s=>window.savedState=s,postMessage:m=>window.messages.push(m)});';
    await page.addScriptTag({ content: 'window.savedState={unrelated:"keep"};' + stateApi });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    const image = (color: string, width = 400, height = 200) => page.evaluate(({ color, width, height }) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      c.getContext('2d')!.fillStyle = color; c.getContext('2d')!.fillRect(0, 0, width, height); return c.toDataURL();
    }, { color, width, height });
    const red = await image('#ff0000'), blue = await image('#0000ff'), green = await image('#00ff00');
    let model: Model = { generation: 1, scene: 'Demo', status: 'Ready', busy: false, stale: false, autoPreview: true,
      linked: false, pairing: '', canSeek: true, canPlay: true, mediaReady: true, duration: 3, fps: 4, position: { time: 1.25, request: 1 },
      media: { uri: red, kind: 'image', token: 'red', sourceId: 'run-1', sourceHash: 'abcdef012345', old: false, duration: 0, rate: 4,
        capture: { requestedTime: 1.25, time: 1.25, frameIndex: 5 }, frame: { width: 8, height: 4 } } };
    const publish = (m = model) => page.evaluate(model => new Promise<void>(resolve => {
      window.addEventListener('message', () => resolve(), { once: true });
      window.postMessage({ kind: 'state', model }, '*');
    }), m);
    const displayed = (token: string) => page.waitForFunction(token => (window as any).messages.some((m: any) => m.kind === 'displayed' && m.token === token), token);
    const referenceShown = (token: string) => page.waitForFunction(token => (window as any).messages.some((m: any) => m.kind === 'referenceDisplayed' && m.token === token), token);
    const pixel = (x: number) => page.locator('.compare-canvas').evaluate((c: HTMLCanvasElement, x) => [...c.getContext('2d')!.getImageData(Math.floor(c.width * x), Math.floor(c.height / 2), 1, 1).data], x);
    await publish(); await displayed('red');
    assert.equal(await page.locator('.preview-controls').evaluate(e => [...e.children].map(e => e.textContent).join('|')).then(s => s.includes('Measure|Compare|')), true);
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Measure', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await page.evaluate(() => (window as any).messages.at(-1)), { kind: 'compare', generation: 1, enabled: true, replace: false, token: 'red', time: undefined });
    const reference = model.media!;
    model = { ...model, comparison: { enabled: true, pending: false, reference } };
    await publish(); await referenceShown('red');
    model = { ...model, generation: 2, position: { time: 1.5, request: 2 }, media: { ...reference, uri: blue, token: 'blue', sourceId: 'run-2', sourceHash: '1234567890ab', capture: { requestedTime: 1.5, time: 1.5, frameIndex: 6 } } };
    await publish(); await displayed('blue');
    assert.deepEqual(await pixel(.25), [255, 0, 0, 255]); assert.deepEqual(await pixel(.75), [0, 0, 255, 255]);
    assert.match(await page.locator('.compare-labels').innerText(), /Reference: 1.250 s · source abcdef01.*Current: 1.500 s · source 12345678/);
    await page.getByRole('button', { name: 'Overlay', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).savedState), { unrelated: 'keep', measure: false, compareMode: 'overlay' });
    const blend = await pixel(.25);
    assert.ok(Math.abs(blend[0] - 127) <= 1 && blend[1] === 0 && Math.abs(blend[2] - 128) <= 1 && blend[3] === 255, `50% blend: ${blend}`);
    const opacity = page.getByLabel('Current image opacity');
    await opacity.focus(); await page.keyboard.press('Home'); assert.deepEqual(await pixel(.75), [255, 0, 0, 255]);
    await page.keyboard.press('End'); assert.deepEqual(await pixel(.25), [0, 0, 255, 255]);
    await page.getByRole('button', { name: 'Wipe', exact: true }).click();
    const divider = page.getByRole('slider', { name: 'Wipe divider', exact: true });
    await divider.focus(); await page.keyboard.press('Home'); assert.deepEqual(await pixel(.25), [0, 0, 255, 255]);
    await page.keyboard.press('End'); assert.deepEqual(await pixel(.75), [255, 0, 0, 255]);
    const messageCount = await page.evaluate(() => (window as any).messages.length);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => (window as any).messages.length), messageCount, 'divider arrows do not seek or invoke Python');
    await page.getByLabel('Wipe position', { exact: true }).fill('50');
    const bounds = (await page.locator('.compare-canvas').boundingBox())!;
    await divider.hover(); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height / 2); await page.mouse.up();
    assert.ok(Math.abs(Number(await divider.getAttribute('aria-valuenow')) - 25) <= 1);
    await page.setViewportSize({ width: 540, height: 850 });
    await page.waitForFunction(() => { const c = document.querySelector('.compare-canvas')!.getBoundingClientRect(); return c.width < 540; });
    const resized = (await page.locator('.compare-canvas').boundingBox())!;
    assert.ok(Math.abs(resized.width / resized.height - 2) < .001, 'resize preserves image aspect at high DPI');
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).enabled), false);
    await publish({ ...model, comparison: { ...model.comparison!, enabled: false } });
    assert.equal(await page.locator('.compare-canvas').isVisible(), false);
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await publish();
    assert.deepEqual(await pixel(.1), [255, 0, 0, 255], 'reenabling does not replace reference');
    await page.getByRole('button', { name: 'Replace reference', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).messages.at(-1)), { kind: 'compare', generation: 2, enabled: true, replace: true, token: 'blue', time: undefined });

    // Keep old current pixels AND the pinned reference through invalidation/decode failure.
    await publish({ ...model, generation: 3, mediaReady: false, stale: true, media: { ...model.media!, old: true } });
    assert.match(await page.locator('.compare-labels').innerText(), /Current: 1.500 s.*OLD/);
    assert.equal(await page.locator('.watermark').innerText(), 'OLD PREVIEW');
    assert.deepEqual(await pixel(.1), [255, 0, 0, 255]); assert.deepEqual(await pixel(.8), [0, 0, 255, 255]);
    await page.route('https://cue.test/broken.png', route => route.fulfill({ status: 404, body: '' }));
    await publish({ ...model, media: { ...model.media!, token: 'broken', uri: 'https://cue.test/broken.png' } });
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'mediaError' && m.token === 'broken'));
    assert.deepEqual(await pixel(.8), [0, 0, 255, 255]);
    await publish({ ...model, comparison: { enabled: true, pending: false, reference: { ...reference, token: 'bad-reference', uri: 'https://cue.test/broken.png' } } });
    await page.waitForFunction(() => document.querySelector('.compare-info')?.textContent?.includes('could not be decoded'));
    assert.deepEqual(await pixel(.1), [255, 0, 0, 255], 'bad reference retains previous decoded reference');
    assert.equal(await page.evaluate(() => (window as any).messages.findLast((m: any) => m.kind === 'referenceError')?.token), 'bad-reference', 'host can roll back the failed reference for future view reconstruction');
    await publish(); // Host rolls back to the last acknowledged reference.
    assert.deepEqual(await pixel(.1), [255, 0, 0, 255]);

    // A superseded reference decode must not overwrite the latest pin or send an ack.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('https://cue.test/slow.png', async route => { await gate; await route.fulfill({ contentType: 'image/png', body: Buffer.from(blue.split(',')[1], 'base64') }); });
    await publish({ ...model, comparison: { enabled: true, pending: false, reference: { ...reference, token: 'slow', uri: 'https://cue.test/slow.png' } } });
    model = { ...model, comparison: { enabled: true, pending: false, reference: { ...reference, token: 'green', uri: green } } };
    await publish(); await referenceShown('green'); release();
    await page.waitForTimeout(100);
    assert.deepEqual(await pixel(.1), [0, 255, 0, 255]);
    assert.equal(await page.evaluate(() => (window as any).messages.some((m: any) => m.kind === 'referenceDisplayed' && m.token === 'slow')), false);
    const square = await image('#0000ff', 200, 200);
    model = { ...model, position: { time: 9, request: 3 }, media: { ...model.media!, token: 'square', uri: square, capture: { requestedTime: 9, time: null, frameIndex: null } } };
    await publish(); await displayed('square');
    assert.match(await page.locator('.compare-info').innerText(), /Different aspect\/frame geometry/);
    assert.match(await page.locator('.compare-labels').innerText(), /Current: End state/);
    await page.getByRole('button', { name: 'Overlay', exact: true }).click();
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).savedState), { unrelated: 'keep', measure: true, compareMode: 'overlay' });
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).enabled), false, 'Measure exits comparison');
    await publish({ ...model, comparison: { ...model.comparison!, enabled: false } });
    assert.equal(await page.locator('.compare-canvas').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Measure', exact: true }).getAttribute('aria-pressed'), 'true');
    await publish({ ...model, comparison: { enabled: false, pending: false } });
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await publish({ ...model, comparison: { enabled: true, pending: false } });
    assert.equal(await page.locator('.compare-canvas').isVisible(), false, 'no reference leaks into a new scene');
    // Host-owned pins and independent preferences restore after webview reconstruction.
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    const preferences = await page.evaluate(() => (window as any).savedState);
    await page.reload();
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: `window.savedState=${JSON.stringify(preferences)};` + stateApi });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    assert.equal(await page.getByRole('button', { name: 'Measure', exact: true }).getAttribute('aria-pressed'), 'true');
    await publish({ ...model, mediaReady: false, media: { ...model.media!, old: true } });
    await displayed('square'); await referenceShown('green');
    assert.equal(await page.getByRole('button', { name: 'Overlay', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Wipe', exact: true }).click();
    assert.equal(await page.locator('.compare-canvas').isVisible(), true);
    assert.deepEqual(await pixel(.25), [0, 255, 0, 255]); assert.deepEqual(await pixel(.75), [0, 0, 255, 255]);
    assert.match(await page.locator('.compare-labels').innerText(), /OLD/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('entering Compare from a playing movie requests its latest presented frame, never an old still', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const movie = await readFile('test/fixtures/seek.mp4');
    await page.route('https://cue.test/movie.mp4', route => {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : movie.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: movie.subarray(start, end + 1),
        headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${movie.length}` } : {}) } });
    });
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.messages.push(m)});' });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    const model: Model = { generation: 1, scene: 'Demo', status: 'Ready', busy: false, stale: false, autoPreview: true,
      linked: true, pairing: '', mediaReady: true, hasMovie: true, canSeek: true, canPlay: true, duration: 3, fps: 4,
      playIntent: 1, position: { time: .5, request: 1 }, media: { uri: 'https://cue.test/movie.mp4', token: 'movie', kind: 'video', old: false, duration: 3, rate: 4 } };
    await page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), model);
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'playback' && m.time >= 1.25), undefined, { timeout: 5000 }).catch(async e => {
      console.error(await page.evaluate(() => ({ messages: (window as any).messages, videos: [...document.querySelectorAll('video')].map(v => ({ time: v.currentTime, ready: v.readyState, duration: v.duration, paused: v.paused, seeking: v.seeking })) })));
      throw e;
    });
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    const request = await page.evaluate(() => (window as any).messages.findLast((m: any) => m.kind === 'compare'));
    assert.equal(request.token, 'movie'); assert.equal(request.enabled, true); assert.equal(request.replace, false);
    assert.ok(request.time >= 1.25 && request.time < 3, 'uses latest presented frame, not playback start or an older capture');
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), true);
    await page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), { ...model, playIntent: undefined, comparison: { enabled: true, pending: true } });
    await page.waitForFunction(() => document.querySelector('.compare-info')?.textContent?.includes('fresh execution'));
    assert.equal(await page.locator('.compare-canvas').isVisible(), false, 'no pretend still/reference while capture is pending');
    assert.equal(await page.getByRole('button', { name: 'Pin reference', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('video').isVisible(), true, 'paused movie remains visible until a still arrives');
  } finally { await browser.close(); }
});
