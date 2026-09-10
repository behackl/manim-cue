import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Model } from '../../src/protocol';

test('frame-only captures can step without playback or an invented duration; static and stale controls stay gated', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.messages.push(m)});' });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; return c.toDataURL(); });
    const model: Model = { generation: 1, scene: 'FrameOnly', status: 'Timeline unavailable', busy: false, stale: false,
      autoPreview: false, linked: false, pairing: '', canSeek: true, canPlay: false, mediaReady: true, fps: 4,
      position: { time: 0, request: 1 }, media: { uri: image, token: 'frame', kind: 'image', old: false, duration: 0, rate: 4,
        capture: { requestedTime: 0, time: 0, frameIndex: 0 } } };
    const publish = (model: Model) => page.evaluate(model => new Promise<void>(resolve => {
      window.addEventListener('message', () => resolve(), { once: true }); window.postMessage({ kind: 'state', model }, '*');
    }), model);
    await publish(model);
    await page.waitForFunction(() => (window as any).messages.some((m: any) => m.kind === 'displayed'));
    const next = page.getByRole('button', { name: 'Next frame', exact: true });
    const previous = page.getByRole('button', { name: 'Previous frame', exact: true });
    assert.equal(await next.isEnabled(), true); assert.equal(await previous.isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Render video', exact: true }).isVisible(), false);
    assert.equal(await page.getByLabel('Preview position', { exact: true }).isDisabled(), true);
    await next.click(); await previous.click();
    await page.locator('.media-stage').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await page.evaluate(() => (window as any).messages.filter((m: any) => m.kind === 'step').map((m: any) => m.direction)), [1, -1, 1, -1]);
    assert.match(await page.locator('.preview-controls .position').innerText(), /\/ —$/);
    for (const blocked of [
      { ...model, duration: 0 }, // Observed static scene, rather than unknown duration.
      { ...model, stale: true, mediaReady: false, media: { ...model.media!, old: true } },
      { ...model, canSeek: false },
    ]) {
      await publish(blocked);
      assert.equal(await next.isDisabled(), true); assert.equal(await previous.isDisabled(), true);
      await page.locator('.media-stage').focus(); await page.keyboard.press('ArrowRight');
    }
    assert.equal(await page.evaluate(() => (window as any).messages.filter((m: any) => m.kind === 'step').length), 4);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
