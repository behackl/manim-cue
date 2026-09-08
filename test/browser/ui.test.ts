import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { parseTimeline } from '../../src/timeline';
import type { Model } from '../../src/protocol';

test('timeline UI uses observed widths, cue placement, safe labels and media-driven positions', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 430 } });
    const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.error('Webview error:', error); });
    await page.setContent('<html><head></head><body style="--vscode-editor-background:#181c24;--vscode-foreground:#ddd;--vscode-descriptionForeground:#a1aab8;--vscode-sideBar-background:#202630;--vscode-panel-border:#323c4a;--vscode-font-family:system-ui"><main id="app"></main></body></html>');
    await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
    await page.addScriptTag({ content: `window.messages = [];
      window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: m => window.messages.push(m) });` });
    await page.addScriptTag({ content: await readFile('dist/timeline.js', 'utf8') });
    const timeline = parseTimeline(await readFile('test/fixtures/timeline-v1.json', 'utf8'));
    const sound = timeline.declarations.find(d => d.kind === 'sound')!;
    if (sound.kind === 'sound') { sound.start = -.25; sound.asset.request = '<img src=x onerror=alert(1)>.wav'; }
    const model: Model = { generation: 1, scene: 'TimelineExample', status: 'Completed observation', busy: false, stale: false, autoPreview: false,
      timeline, profile: 'Cairo · 4 fps · 320×180', linked: true, pairing: '' };
    await page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), model);
    await page.waitForSelector('g.event', { timeout: 5000 }).catch(async error => {
      console.error(await page.locator('body').innerText());
      await page.screenshot({ path: '/tmp/manim-cue-ui-failure.png' });
      throw error;
    });
    assert.equal(await page.locator('g.event').count(), 5);
    assert.equal(await page.locator('.banner').isVisible(), false, 'no alignment banner during normal linked playback');
    await page.getByRole('button', { name: 'Python', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).kind), 'doctor');
    assert.equal(await page.locator('.tick-label').first().evaluate(n => getComputedStyle(n).userSelect), 'none');
    const tick = (await page.locator('.tick-label').first().boundingBox())!;
    await page.mouse.move(tick.x + 2, tick.y + 4); await page.mouse.down();
    await page.mouse.move(tick.x + 350, tick.y + 100, { steps: 15 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '', 'scrubbing across labels cannot select text');
    const widths = await page.locator('g.event rect').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('width'))));
    assert.ok(Math.abs(widths[0] / widths[3] - 2) < 1e-9, 'ordinary .3 request spans twice the frozen .3 request');
    await page.locator('g.sound').click();
    // Simulate the host accepting the selected declaration, not a hidden state mutation.
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, selected: 'declaration:7' } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.inspector')?.textContent?.includes('Unknown — not decoded'));
    assert.match(await page.locator('.inspector').innerText(), /-0.25 s/);
    assert.equal(await page.locator('.inspector img').count(), 0, 'cue labels never become markup');
    const before = await page.locator('.playhead').getAttribute('x1');
    await page.evaluate(() => window.postMessage({ kind: 'position', generation: 1, time: 1 }, '*'));
    await page.waitForFunction(() => document.querySelector('.position')?.textContent === 'Video 1 s');
    assert.notEqual(await page.locator('.playhead').getAttribute('x1'), before);
    await page.evaluate(() => window.postMessage({ kind: 'position', generation: 0, time: 99 }, '*'));
    assert.equal(await page.locator('.position').innerText(), 'Video 1 s', 'stale generation cannot move the playhead');
    await page.screenshot({ path: '/tmp/manim-cue-timeline.png' });
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, stale: true, linked: false, pairing: 'Old preview — unlinked from the displayed timeline' } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.banner')?.textContent?.includes('STALE OBSERVATION'));
    assert.equal(await page.locator('.banner').isVisible(), true, 'actionable stale warnings remain');
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, linked: false, busy: true,
      position: { time: 1.25, request: 3 }, timeline: { ...model.timeline!, revision: 'a'.repeat(64) } } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.position')?.textContent === 'Inspect 1.25 s');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
