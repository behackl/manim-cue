import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTimeline } from '../../src/timeline';
import { model, video, webview } from './page';

test('the timeline shows the entries, owns the selection and the loop, and moves the preview', async () => {
  const w = await webview('timeline', { width: 1240, height: 430 }), { page } = w;
  try {
    const timeline = parseTimeline(await readFile('test/fixtures/timeline-v1.json', 'utf8'));
    const sound = timeline.entries[7];
    if (sound.kind === 'sound') { sound.start = -.25; sound.duration = null; sound.file = '<img src=x onerror=alert(1)>.wav'; }
    const base = model({ scene: 'TimelineExample', time: 0, timeline, timelineKey: 'run-1', profile: '4 fps · 320 × 180', video: video({ duration: 2.25 }) });
    await w.publish(base);
    await page.waitForSelector('g.event', { timeout: 5000 });
    assert.equal(await page.locator('g.event').count(), 5);
    assert.equal(await page.locator('.banner').isVisible(), false);
    assert.deepEqual(await page.locator('.toolbar button:visible').allTextContents(), ['↻ Refresh', 'Loop selection']);
    assert.equal(await page.locator('.toolbar .status').count(), 0, 'the preview shows the status');
    assert.equal(await page.getByRole('button', { name: 'Loop selection', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.selection-range').evaluate(e => e.classList.contains('muted')), true);
    // A click selects a play and moves the preview to its start.
    await page.locator('g.event').nth(1).click();
    assert.deepEqual((await w.messages()).at(-1), { kind: 'seek', time: .5 });
    await page.locator('g.event').nth(3).click({ modifiers: ['Meta'] });
    assert.equal(await page.locator('g.event.selected').count(), 2);
    assert.equal(await page.locator('.selection-range').innerText(), '0.50–1.75 s');
    await page.locator('g.event').nth(4).click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('g.event.selected').count(), 2, 'a range from the anchor');
    await page.locator('g.event').nth(0).click(); await page.locator('g.event').nth(2).click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('g.event.selected').count(), 3);
    assert.equal(await page.locator('.loop-region').count(), 1, 'one region includes the plays between');
    await page.getByRole('button', { name: 'Loop selection', exact: true }).click();
    assert.deepEqual((await w.messages()).at(-1), { kind: 'loop', range: { start: 0, end: 1.5 } });
    await w.publish({ ...base, loop: { start: 0, end: 1.5 } });
    assert.equal(await page.getByRole('button', { name: 'Loop selection', exact: true }).getAttribute('aria-pressed'), 'true');
    // A scrub moves the preview.
    const tick = (await page.locator('.tick-label').first().boundingBox())!;
    await page.mouse.move(tick.x + 2, tick.y + 4); await page.mouse.down();
    await page.mouse.move(tick.x + 350, tick.y + 100, { steps: 15 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '', 'scrubbing across labels selects no text');
    assert.equal((await w.messages()).at(-1).kind, 'seek');
    // One click sends one seek; a click before 0 s seeks to 0 s.
    const seeks = async () => (await w.messages()).filter(m => m.kind === 'seek');
    const before = (await seeks()).length, zero = (await page.locator('.outside-span').first().boundingBox())!;
    await page.mouse.click(zero.x + zero.width / 2, zero.y + 40);
    assert.deepEqual((await seeks()).slice(before), [{ kind: 'seek', time: 0 }]);
    // The position of the playing preview moves the playhead.
    await w.send({ kind: 'position', time: 1 });
    assert.equal(await page.locator('.position').innerText(), '1.00 s');
    const widths = await page.locator('g.event rect').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('width'))));
    assert.ok(Math.abs(widths[0] / widths[3] - 2) < 1e-9, 'a .3 s play spans twice the frozen .3 s wait');
    // The inspector.
    await page.locator('g.sound').click();
    assert.match(await page.locator('.inspector').innerText(), /TIME\s+-0.25 s\n/i, 'a sound without a duration shows only its start');
    assert.match(await page.locator('.inspector').innerText(), /timeline_scene.py, line 22/);
    assert.equal(await page.locator('.inspector img').count(), 0, 'labels never become markup');
    await page.locator('g.event').nth(3).click();
    const wait = await page.locator('.inspector').innerText();
    assert.match(wait, /^Wait/); assert.match(wait, /1.50–1.75 s/); assert.match(wait, /Requested run time\s+0.30 s/i); assert.match(wait, /Still image/);
    await page.locator('g.event').nth(0).click();
    assert.match(await page.locator('.inspector').innerText(), /^Play[\s\S]*\.animate/);
    assert.deepEqual(await page.locator('.legend-item').allTextContents(), ['Play', 'Wait', 'Still image', 'Not in the video', 'Sound']);
    assert.equal(await page.locator('g.event.frozen').count(), 1);
    assert.equal(await page.getByText('The scene ended early.').isVisible(), false);
    // The render's timeline keeps the selection; skipped plays have their own style.
    const skipped = { ...timeline, ended_early: true, entries: timeline.entries.map((e, i) => i === 3 ? { ...e, skipped: true } : e) };
    await w.publish({ ...base, timeline: skipped });
    assert.equal(await page.locator('g.event.skipped').count(), 1);
    assert.equal(await page.getByText('The scene ended early.').isVisible(), true);
    await page.locator('g.event').nth(1).click();
    assert.match(await page.locator('.inspector').innerText(), /Not in the video: this section is skipped\./);
    // Sound bars show the file name.
    const named = { ...timeline, entries: timeline.entries.map(e => e.kind === 'sound' ? { ...e, start: 0, duration: 2, file: 'assets/click.wav' } : e) };
    await w.publish({ ...base, timeline: named });
    assert.equal(await page.locator('g.sound text').textContent(), 'click.wav');
    // A short bar cuts the label with an ellipsis; the tooltip has the full text.
    const caption = 'a caption that is much longer than its bar';
    const section = 'a section name that is longer than the space';
    const short = { ...timeline, entries: [...timeline.entries.map(e => e.kind === 'sound' ? { ...e, start: 0, duration: .3, file: 'assets/a-long-sound-name.wav' }
      : e.kind === 'caption' ? { ...e, content: caption } : e.kind === 'section' ? { ...e, name: section } : e),
    { kind: 'section', start: .15, name: 'next', type: 'default.normal', skip_animations: false, source: null } as const] };
    await w.publish({ ...base, timeline: short });
    for (const [kind, full] of [['sound', 'a-long-sound-name.wav'], ['caption', caption], ['section', section]]) {
      const label = await page.locator(`g.${kind} text`).first().textContent() ?? '';
      assert.ok(label.endsWith('…') && full.startsWith(label.slice(0, -1)), `${kind} label: ${label}`);
      assert.ok((await page.locator(`g.${kind} title`).first().textContent())?.startsWith(full));
    }
    // An outdated timeline is dim, with one banner, and has no loop.
    await w.publish({ ...base, timeline: named, timelineOutdated: true, busy: true });
    assert.equal(await page.locator('.banner').innerText(), 'This timeline is outdated.');
    assert.equal(await page.locator('.chart').evaluate(e => e.classList.contains('outdated')), true);
    assert.equal(await page.getByRole('button', { name: 'Loop selection', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '■ Cancel', exact: true }).isVisible(), true);
    // A new timeline starts a new selection.
    await w.publish({ ...base, timelineKey: 'run-2' });
    assert.equal(await page.locator('g.event.selected').count(), 0);
    await w.publish({ ...base, timelineKey: 'run-2', error: 'The timeline update failed: RuntimeError: x' });
    assert.equal(await page.getByRole('button', { name: 'Check Python', exact: true }).isVisible(), false, 'an error of the scene');
    await w.publish({ ...base, timelineKey: 'run-2', error: 'Manim is not installed in this Python environment.', pythonProblem: true });
    await page.getByRole('button', { name: 'Check Python', exact: true }).click();
    assert.equal((await w.messages()).at(-1).kind, 'doctor');
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});
