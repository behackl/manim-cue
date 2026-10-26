import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Model } from '../../src/protocol';

test('a video with a skipped part seeks, reports and plays in scene time', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const movie = await readFile('test/fixtures/seek.mp4');
    await page.route('https://cue.test/*.mp4', route => {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : movie.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: movie.subarray(start, end + 1),
        headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${movie.length}` } : {}) } });
    });
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.messages.push(m)});' });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    // The 3 s video leaves out the scene time 1–2 s, so the scene has 4 s.
    const model: Model = { generation: 1, scene: 'Demo', status: 'Up to date', busy: false, timelineOutdated: false, autoPreview: true,
      followsVideo: true, notice: '', canSeek: true, duration: 4, fps: 4, hasVideo: true, mediaReady: true, position: { time: 2.25, request: 1 },
      media: { uri: 'https://cue.test/a.mp4', kind: 'video', token: 'a', outdated: false, duration: 4, rate: 4, seekTime: 2.25,
        skipped: [{ start: 1, end: 2 }], frame: { width: 8, height: 4 } } };
    const publish = (m: Model) => page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), m);
    const playback = (request: number) => page.evaluate(request => (window as any).messages
      .filter((m: any) => m.kind === 'playback' && m.seekSequence === request).map((m: any) => m.time), request);
    await publish(model);
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'playback' && m.time === 2.25));
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), 1.375, 'the middle of video frame 5');
    assert.equal(await page.locator('.preview-controls .position').innerText(), '2.250 s / 4.000 s');
    await publish({ ...model, position: { time: .5, request: 2 }, playIntent: 1, media: { ...model.media!, seekTime: .5 } });
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'playback' && m.seekSequence === 2 && m.time >= 2.5));
    const times: number[] = await playback(2);
    assert.ok(times.some(t => t < 1) && times.every(t => t < 1 || t >= 2), `playback goes over the skipped part: ${times}`);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await publish({ ...model, position: { time: 0, request: 3 }, playIntent: 2, media: { ...model.media!, seekTime: 0, loop: { start: .5, end: 2.5 } } });
    await page.waitForFunction(() => {
      const times = (window as any).messages.filter((m: any) => m.kind === 'playback' && m.seekSequence === 3).map((m: any) => m.time);
      return times.some((t: number, i: number) => i > 0 && t < times[i - 1]);
    });
    assert.ok((await playback(3)).every((t: number) => t >= .5 && t < 2.5 && (t < 1 || t >= 2)), 'the loop repeats in scene time');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
