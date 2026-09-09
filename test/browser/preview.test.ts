import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Model } from '../../src/protocol';

test('preview swaps at the selected position, paused, without reporting initial frame zero', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const movie = await readFile('test/fixtures/seek.mp4');
    let releaseMovie!: () => void;
    const movieGate = new Promise<void>(resolve => { releaseMovie = resolve; });
    await page.route('https://cue.test/*.mp4', async route => {
      if (route.request().url().endsWith('/b.mp4')) await movieGate;
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
      linked: true, pairing: '', position: { time: 1.25, request: 1 },
      media: { uri: 'https://cue.test/a.mp4', kind: 'video', token: 'a', old: false, duration: 3, rate: 4, frame: { width: 8, height: 4 } } };
    const publish = (m: Model) => page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), m);
    await publish(model);
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'playback' && m.time === 1.25), undefined, { timeout: 5000 }).catch(async e => {
      console.error(await page.evaluate(() => ({ messages: (window as any).messages, videos: [...document.querySelectorAll('video')].map(v => ({ time: v.currentTime, ready: v.readyState, seeking: v.seeking, style: v.getAttribute('style') })) })));
      throw e;
    });
    await page.getByRole('button', { name: 'Measure (fixed 2D)', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.measure-layer')?.hasAttribute('hidden'));
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.controls), false);
    const hit = page.locator('.measure-surface');
    let box = (await hit.boundingBox())!;
    const videoBox = (await page.locator('video').boundingBox())!;
    assert.ok(Math.abs(box.width - box.height) < .01, 'square content, not the wide letterboxed element');
    assert.ok(box.width < videoBox.width, 'pillarbox margins are excluded');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.measure-readout')?.textContent === '(0, 0)');
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .75, box.y + box.height * .25, { steps: 3 });
    await page.mouse.up();
    assert.match(await page.locator('.measure-readout').innerText(), /Δx 2 · Δy 1 · distance 2.23607/);
    await page.getByRole('button', { name: 'Copy point', exact: true }).click();
    const copied = await page.evaluate(() => (window as any).messages.findLast((m: any) => m.kind === 'copyPoint'));
    assert.deepEqual(copied, { kind: 'copyPoint', token: 'a', x: 2, y: 1 });
    await page.setViewportSize({ width: 650, height: 800 });
    await page.waitForTimeout(100);
    box = (await hit.boundingBox())!;
    assert.ok(Math.abs(box.width - box.height) < .01, 'resize preserves content mapping at device scale 2');
    await hit.focus(); await page.keyboard.press('Escape');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.measure-readout')?.textContent === '(0, 0)');
    await publish({ ...model, busy: true, stale: true, linked: false, position: { time: 1.25, request: 2 }, media: { ...model.media!, old: true } });
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), true);
    await page.waitForFunction(() => document.querySelector('.measure-layer')?.hasAttribute('hidden'));
    assert.equal(await page.getByRole('button', { name: 'Copy point', exact: true }).isDisabled(), true);
    const captured = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 400;
      canvas.getContext('2d')!.fillRect(0, 0, 400, 400); return canvas.toDataURL();
    });
    const frameModel: Model = { ...model, generation: 2, busy: true, stale: true, linked: false, mediaReady: true,
      position: { time: 1.25, request: 2 }, media: { ...model.media!, kind: 'image', uri: captured, token: 'frame', sourceId: 'new',
        capture: { requestedTime: 1.25, time: 1.25, frameIndex: 5 } } };
    await publish(frameModel);
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'displayed' && m.token === 'frame'));
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.locator('.measure-layer').isVisible(), true, 'fresh frame remains measurable while the timeline updates');
    const oldFrame = { ...frameModel, generation: 3, mediaReady: false, position: { time: 1.25, request: 3 },
      media: { ...frameModel.media!, old: true } };
    await publish(oldFrame);
    assert.equal(await page.locator('img').isVisible(), true, 'editing again retains the still');
    assert.equal(await page.locator('.watermark').innerText(), 'OLD PREVIEW');
    // A hidden/recreated VS Code webview must also restore stale media, not wait for freshness.
    await page.reload();
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.messages.push(m)});' });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    await publish(oldFrame);
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'displayed' && m.token === 'frame'), undefined, { timeout: 5000 });
    assert.equal(await page.locator('img').isVisible(), true, 'stale still restored after view recreation');
    assert.equal(await page.locator('.watermark').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Measure (fixed 2D)', exact: true }).click();
    assert.equal(await page.locator('.measure-layer').isVisible(), false, 'stale image is display-only');
    const movieModel: Model = { ...model, generation: 3, mediaReady: true, position: { time: 1.25, request: 3 },
      media: { ...model.media!, uri: 'https://cue.test/b.mp4', token: 'b', sourceId: 'new', frame: { width: 12, height: 6 } } };
    await publish(movieModel);
    assert.equal(await page.locator('img').isVisible(), true, 'still stays mounted while movie loads');
    await publish({ ...movieModel, position: { time: 2.25, request: 4 } });
    releaseMovie();
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'playback' && m.token === 'b' && m.time === 2.25));
    assert.equal(await page.locator('video').count(), 1);
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), true);
    await page.waitForFunction(() => document.querySelector('.measure-assumption')?.textContent?.includes('12 × 6'));
    assert.equal(await page.locator('.measure-pin').count(), 0, 'old measurement cleared on replacement');
    await page.getByRole('button', { name: 'Measure (fixed 2D)', exact: true }).click();
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.controls), true);
    const positions = await page.evaluate(() => (window as any).messages.filter((m: any) => m.kind === 'playback'));
    assert.ok(positions.every((m: any) => m.time > 0), 'no initial frame-zero messages escape');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).kind), 'play');
    await publish({ ...movieModel, position: { time: 2.25, request: 4 }, playIntent: 1 });
    await page.waitForFunction(() => !document.querySelector('video')?.paused);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), true);
    await page.route('https://cue.test/broken.png', route => route.fulfill({ status: 404, body: '' }));
    await publish({ ...model, generation: 2, mediaReady: true, linked: false, position: { time: 2.25, request: 4 },
      media: { ...model.media!, kind: 'image', token: 'broken', uri: 'https://cue.test/broken.png' } });
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'mediaError' && m.token === 'broken'));
    assert.equal(await page.locator('video').isVisible(), true, 'candidate failure retains the displayed movie');
    const still = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200; return canvas.toDataURL();
    });
    await publish({ ...model, linked: false, media: { ...model.media!, kind: 'image', uri: still, token: 'still', frame: { width: 10, height: 5 } } });
    await page.waitForFunction(() => !document.querySelector('img')?.hidden);
    await page.getByRole('button', { name: 'Measure (fixed 2D)', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.measure-layer')?.hasAttribute('hidden'));
    box = (await hit.boundingBox())!;
    assert.ok(Math.abs(box.width / box.height - 2) < .001, 'still uses its own intrinsic aspect');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.measure-readout')?.textContent === '(0, 0)');
    await publish({ ...model, media: { ...model.media!, frame: undefined } });
    await page.waitForFunction(() => document.querySelector('.measure-layer')?.hasAttribute('hidden'));
    assert.equal(await page.getByRole('button', { name: 'Copy point', exact: true }).isDisabled(), true, 'never invent dimensions');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
