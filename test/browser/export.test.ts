import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import type { Model } from '../../src/protocol';
import type { ExportDialogModel } from '../../src/export-settings';

test('export dialog separates copies from renders, validates settings, and keeps focus/keyboard behavior local', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.messages.push(m)});' });
    await page.addScriptTag({ content: await readFile('dist/preview.js', 'utf8') });
    const model: Model = { generation: 1, scene: 'Demo', status: 'Ready', busy: false, stale: false, autoPreview: false, linked: false, pairing: '' };
    const publish = (m: Model) => page.evaluate(model => new Promise<void>(resolve => {
      window.addEventListener('message', () => resolve(), { once: true }); window.postMessage({ kind: 'state', model }, '*');
    }), m);
    await publish(model);
    const opener = page.getByRole('button', { name: 'Export…', exact: true });
    await opener.click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).kind), 'openExport');
    const dialog: ExportDialogModel = { id: 'export-1', scene: 'Demo', aspect: 16 / 9, previewSize: { width: 960, height: 540 },
      frame: { kind: 'image', description: 'OLD · 1.250 s · 960 × 540 · source abcdef01' }, video: 'OLD · 3 s · H.264 · includes audio', timeline: 'revision abcdef',
      canCapture: false, dirty: false, newer: false,
      choice: { kind: 'frame', method: 'copy', settings: { width: 1920, height: 1080, fps: 29.97, crf: 18, preset: 'medium', options: '' } } };
    const state = (d = dialog, busy = false) => ({ ...model, exportState: { busy, nativeBusy: false, dialog: d } });
    await publish(state());
    assert.equal(await page.getByRole('dialog', { name: 'Export' }).isVisible(), true);
    assert.match(await page.locator('.export-summary').innerText(), /OLD.*1.250/);
    assert.equal(await page.getByLabel('Frame rate (fps)').isVisible(), false);
    assert.match(await page.locator('.export-note:visible').last().innerText(), /not the comparison reference/);
    await page.getByRole('button', { name: 'Save PNG…', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).choice.kind), 'frame');
    await page.getByRole('button', { name: 'Video', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Save MP4…', exact: true }).isEnabled(), true);
    assert.equal(await page.getByLabel('Frame rate (fps)').isVisible(), false);
    await page.getByRole('button', { name: 'New render', exact: true }).click();
    assert.equal(await page.getByLabel('Frame rate (fps)').inputValue(), '29.97');
    await page.getByLabel('Resolution', { exact: true }).selectOption('720');
    assert.equal(await page.getByLabel('Width (px)').inputValue(), '1280');
    assert.equal(await page.getByLabel('Height (px)').inputValue(), '720');
    assert.equal(await page.getByLabel('Frame rate (fps)').inputValue(), '29.97', 'resolution presets do not alter execution FPS');
    await page.getByLabel('Width (px)').fill('640');
    assert.equal(await page.getByLabel('Height (px)').inputValue(), '360');
    await page.getByText('Advanced', { exact: true }).click();
    const options = page.getByLabel('Additional codec options — one key=value per line');
    await options.fill('crf=30');
    const submit = page.getByRole('button', { name: 'Render and save…', exact: true });
    assert.equal(await submit.isDisabled(), true);
    assert.match(await page.getByRole('alert').innerText(), /controls/);
    await options.fill('threads=2\nx264-params=keyint=30');
    const before = await page.evaluate(() => (window as any).messages.length);
    await options.press('Space'); await options.press('ArrowLeft');
    assert.equal(await page.evaluate(() => (window as any).messages.length), before, 'typing in export does not play or seek the preview');
    await submit.click();
    const request = await page.evaluate(() => (window as any).messages.at(-1));
    assert.equal(request.kind, 'submitExport'); assert.equal(request.id, 'export-1'); assert.equal(request.choice.method, 'render');
    assert.equal(request.choice.settings.width, 640); assert.equal(request.choice.settings.fps, 29.97);
    await publish(state({ ...dialog, newer: true, dirty: true }));
    assert.equal(await page.getByRole('button', { name: 'Use latest preview', exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('Width (px)').inputValue(), '640', 'state updates do not overwrite the draft');
    await page.getByRole('button', { name: 'Timeline JSON', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Save JSON…', exact: true }).isEnabled(), true);
    assert.equal(await page.getByLabel('Frame rate (fps)').isVisible(), false);
    await page.setViewportSize({ width: 360, height: 400 });
    const bounds = (await page.getByRole('dialog').boundingBox())!;
    assert.ok(bounds.width <= 360 && bounds.height <= 400);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await opener.evaluate(e => e === document.activeElement), true);
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).kind), 'closeExport');
    await publish(state({ ...dialog, id: 'export-2', frame: { kind: 'video', description: '1.250 s · movie' }, canCapture: true }));
    assert.equal(await page.getByRole('button', { name: 'Capture and save PNG…', exact: true }).isEnabled(), true);
    assert.match(await page.locator('.export-note:visible').last().innerText(), /not movie pixel extraction/);
    await publish({ ...model, exportState: { busy: true, nativeBusy: true, status: 'Export rendering' } });
    assert.equal(await page.getByRole('dialog').count(), 0, 'accepted job leaves the preview accessible');
    await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).kind), 'cancelExport');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
