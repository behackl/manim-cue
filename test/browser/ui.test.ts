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
    const sound = timeline.entries[7];
    if (sound.kind === 'sound') { sound.start = -.25; sound.duration = null; sound.file = '<img src=x onerror=alert(1)>.wav'; }
    const model: Model = { generation: 1, scene: 'TimelineExample', status: 'Up to date', busy: false, timelineOutdated: false, autoPreview: false,
      timeline, profile: '4 fps · 320 × 180', followsVideo: true, notice: '' };
    await page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), model);
    await page.waitForSelector('g.event', { timeout: 5000 }).catch(async error => {
      console.error(await page.locator('body').innerText());
      await page.screenshot({ path: '/tmp/manim-cue-ui-failure.png' });
      throw error;
    });
    assert.equal(await page.locator('g.event').count(), 5);
    assert.equal(await page.locator('.banner').isVisible(), false, 'no banner during normal video playback');
    assert.deepEqual(await page.locator('.toolbar button:visible').allTextContents(), ['↻ Refresh', 'Loop selection']);
    assert.equal(await page.locator('.toolbar input').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Loop selection', exact: true }).isDisabled(), true);
    await page.locator('g.event').nth(0).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).mode), 'replace');
    await page.locator('g.event').nth(2).click({ modifiers: ['Meta'] });
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).mode), 'toggle');
    await page.locator('g.event').nth(4).click({ modifiers: ['Shift'] });
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).mode), 'range');
    const selection = { start: 0, end: 1.5, enabled: false, available: true };
    await page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), { ...model,
      selectedEvents: [1, 4], selection });
    await page.waitForFunction(() => document.querySelectorAll('g.event.selected').length === 2);
    assert.equal(await page.locator('g.event.selected').count(), 2);
    assert.equal(await page.locator('.loop-region').count(), 1, 'one continuous region includes intervening events');
    await page.getByRole('button', { name: 'Loop selection', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).enabled), true);
    assert.equal(await page.locator('.tick-label').first().evaluate(n => getComputedStyle(n).userSelect), 'none');
    const tick = (await page.locator('.tick-label').first().boundingBox())!;
    await page.mouse.move(tick.x + 2, tick.y + 4); await page.mouse.down();
    await page.mouse.move(tick.x + 350, tick.y + 100, { steps: 15 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '', 'scrubbing across labels cannot select text');
    const widths = await page.locator('g.event rect').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('width'))));
    assert.ok(Math.abs(widths[0] / widths[3] - 2) < 1e-9, 'ordinary .3 request spans twice the frozen .3 request');
    await page.locator('g.sound').click();
    // Simulate the host accepting the selected sound, not a hidden state mutation.
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, selected: 7 } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.inspector h3')?.textContent === 'Sound');
    assert.match(await page.locator('.inspector').innerText(), /TIME\s+-0.25 s\n/i, 'a sound without a duration shows only its start');
    assert.match(await page.locator('.inspector').innerText(), /timeline_scene.py, line 22/);
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, selected: 5 } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.inspector h3')?.textContent === 'Wait');
    const wait = await page.locator('.inspector').innerText();
    assert.match(wait, /1.50–1.75 s/); assert.match(wait, /Requested run time\s+0.30 s/i); assert.match(wait, /Still image/);
    assert.doesNotMatch(wait, /Not in the video/);
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, selected: 1 } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.inspector h3')?.textContent === 'Play');
    assert.match(await page.locator('.inspector').innerText(), /\.animate/);
    assert.deepEqual(await page.locator('.legend-item').allTextContents(), ['Play', 'Wait', 'Still image', 'Not in the video', 'Sound']);
    assert.equal(await page.locator('g.event.frozen').count(), 1);
    assert.equal(await page.getByText('The scene ended early.').isVisible(), false);
    const skipped = { ...timeline, ended_early: true, entries: timeline.entries.map((e, i) => i === 3 ? { ...e, skipped: true } : e) };
    await page.evaluate(model => window.postMessage({ kind: 'state', model }, '*'), { ...model, timeline: skipped, selected: 3 });
    await page.waitForFunction(() => document.querySelectorAll('g.event.skipped').length === 1);
    assert.equal(await page.getByText('The scene ended early.').isVisible(), true);
    assert.match(await page.locator('.inspector').innerText(), /Not in the video \(skipped section\)/);
    assert.equal(await page.locator('.inspector img').count(), 0, 'cue labels never become markup');
    const before = await page.locator('.playhead').getAttribute('x1');
    await page.evaluate(() => window.postMessage({ kind: 'position', generation: 1, time: 1 }, '*'));
    await page.waitForFunction(() => document.querySelector('.position')?.textContent === '1 s');
    assert.notEqual(await page.locator('.playhead').getAttribute('x1'), before);
    await page.evaluate(() => window.postMessage({ kind: 'position', generation: 0, time: 99 }, '*'));
    assert.equal(await page.locator('.position').innerText(), '1 s', 'old generation cannot move the playhead');
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, timelineOutdated: true, followsVideo: false, selection: { start: 0, end: 1, enabled: false, available: false }, notice: 'Outdated' } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.banner')?.textContent?.includes('outdated'));
    assert.equal(await page.locator('.banner').isVisible(), true, 'outdated timeline warning remains');
    assert.equal(await page.getByRole('button', { name: 'Loop selection', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.loop-region.outdated').count(), 1);
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, followsVideo: false, busy: true,
      position: { time: 1.25, request: 3 }, timeline: { ...model.timeline!, mode: 'render' } } }, '*'), model);
    await page.waitForFunction(() => document.querySelector('.position')?.textContent === '1.25 s');
    assert.equal(await page.getByRole('button', { name: '■ Cancel', exact: true }).isVisible(), true);
    await page.evaluate(model => window.postMessage({ kind: 'state', model: { ...model, error: 'Python import failed' } }, '*'), model);
    await page.getByRole('button', { name: 'Check Python', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).messages.at(-1).kind), 'doctor');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
