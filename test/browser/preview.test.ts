import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, model, video, webview } from './page';

const positions = async (w: Awaited<ReturnType<typeof webview>>) => (await w.messages()).filter(m => m.kind === 'position').map(m => m.time);
const currentTime = (w: Awaited<ReturnType<typeof webview>>) => w.page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);

test('the preview plays the current video in scene time and reports its position', async () => {
  const w = await webview('preview'), { page } = w;
  try {
    await w.publish(model({ time: 1.25, video: video() }));
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.style.visibility && Math.abs(v.currentTime - 1.375) < 1e-3; });
    assert.equal(await page.locator('.preview-controls .position').innerText(), '1.25 s / 3.00 s');
    assert.equal(await page.locator('.watermark').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Render video', exact: true }).isVisible(), false, 'Auto Preview renders the video');
    // A seek from the timeline view moves the video and is not reported back.
    await w.send({ kind: 'seek', time: 2 });
    await page.waitForFunction(() => Math.abs(document.querySelector('video')!.currentTime - 2.125) < 1e-3);
    assert.deepEqual(await positions(w), []);
    await page.getByRole('button', { name: 'Next frame', exact: true }).click();
    assert.deepEqual(await positions(w), [2.25]);
    await page.getByLabel('Position', { exact: true }).focus(); await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await positions(w), [2.25, 2]);
    await page.locator('.media-stage').focus(); await page.keyboard.press('ArrowRight');
    assert.deepEqual((await positions(w)).at(-1), 2.25);
    assert.deepEqual((await w.messages()).filter(m => m.kind === 'frameNeeded'), [], 'the video has every frame');
    // Playback reports frame times; Pause keeps the last one.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => (window as any).messages.filter((m: any) => m.kind === 'position').at(-1).time > 2.5);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const paused = (await positions(w)).at(-1)!;
    assert.equal(paused * 4 % 1, 0, 'a frame start');
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), true);
    // A loop from the timeline view repeats in scene time.
    await w.publish(model({ time: paused, video: video(), loop: { start: 1, end: 2 } }));
    const before = (await w.messages()).length;
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(before => {
      const times = (window as any).messages.slice(before).filter((m: any) => m.kind === 'position').map((m: any) => m.time);
      return times.some((t: number, i: number) => i > 0 && t < times[i - 1]);
    }, before);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const looped = (await w.messages()).slice(before).filter(m => m.kind === 'position').map(m => m.time);
    assert.ok(looped.every(t => t >= 1 && t < 2), `only the loop plays: ${looped}`);
    // Measurement uses the shown video.
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    const box = (await page.locator('.measure-surface').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.measure-readout')?.textContent === '(0, 0)');
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .75, box.y + box.height * .25, { steps: 3 }); await page.mouse.up();
    assert.match(await page.locator('.measure-readout').innerText(), /Δx 2 · Δy 1 · distance 2.23607/);
    await page.getByRole('button', { name: 'Copy point', exact: true }).click();
    assert.deepEqual((await w.messages()).at(-1), { kind: 'copyPoint', x: 2, y: 1 });
    await page.getByRole('button', { name: 'Export…', exact: true }).click();
    assert.deepEqual((await w.messages()).at(-1), { kind: 'openExport', time: (await positions(w)).at(-1), video: true });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal((await w.messages()).at(-1).kind, 'settings');
    // An outdated video stays with a watermark and still plays.
    await w.publish(model({ time: 1, video: video({ outdated: true }), timelineOutdated: true, job: undefined }));
    await page.waitForFunction(() => document.querySelector('.watermark')?.textContent === 'OUTDATED');
    assert.equal(await page.locator('.preview-controls .position').innerText(), `${Number((await positions(w)).at(-1)).toFixed(2)} s / 3.00 s`, 'the duration stays');
    assert.equal(await page.getByRole('button', { name: 'Next frame', exact: true }).isDisabled(), false);
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});

test('without a current video, the preview asks for the frame at its position', async () => {
  const w = await webview('preview'), { page } = w;
  try {
    await w.publish(model({ time: 1, autoPreview: false }));
    assert.equal((await w.message('frameNeeded')).time, 1);
    assert.equal(await page.getByRole('button', { name: 'Render video', exact: true }).isVisible(), true);
    const red = await frame(page, 1);
    await w.publish(model({ time: 1, autoPreview: false, frame: red }));
    await page.waitForFunction(() => { const img = document.querySelector('.media-stage img') as HTMLImageElement | null; return !!img && !img.style.visibility; });
    assert.equal(await page.locator('.watermark').isVisible(), false);
    // A new position keeps the old frame until the new one is there.
    await page.getByRole('button', { name: 'Next frame', exact: true }).click();
    assert.equal((await w.message('frameNeeded')).time, 1.25);
    assert.equal(await page.locator('.watermark').innerText(), 'FRAME AT 1.00 S', 'the host is idle: the shown frame is for another time');
    await w.publish(model({ time: 1.25, autoPreview: false, frame: red, busy: true }));
    assert.equal(await page.locator('.watermark').innerText(), 'UPDATING FRAME');
    // After Cancel, the same position is asked for again when the user chooses it.
    await w.publish(model({ time: 1.25, autoPreview: false, frame: red, status: 'Cancelled' }));
    await w.send({ kind: 'seek', time: 1.25 });
    assert.equal((await w.messages()).filter(m => m.kind === 'frameNeeded' && m.time === 1.25).length, 2);
    const blue = await frame(page, 1.25, '#00f');
    await w.publish(model({ time: 1.25, autoPreview: false, frame: blue }));
    await page.waitForFunction(() => document.querySelector('.watermark')!.hasAttribute('hidden'));
    // Each position is asked for once in each job.
    const asked = (await w.messages()).filter(m => m.kind === 'frameNeeded').length;
    await w.publish(model({ time: 1.25, autoPreview: false, frame: blue, status: 'Rendering video…' }));
    assert.equal((await w.messages()).filter(m => m.kind === 'frameNeeded').length, asked);
    // After the end of the scene, the frame is the last frame.
    await w.publish(model({ time: 1.25, autoPreview: false, duration: 1, frame: blue }));
    assert.equal((await w.message('position')).time, .75, 'the position moves to the last frame');
    const last = await frame(page, .75, '#0f0', { time: null });
    await w.publish(model({ time: .75, autoPreview: false, duration: 1, frame: last }));
    await page.waitForFunction(() => document.querySelector('.banner')?.textContent?.includes('last frame'));
    assert.equal(await page.locator('.preview-controls .position').innerText(), 'Last frame / 1.00 s');
    // Play without a video asks for one. A failed render ends the wait; a later video does not start by itself.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    assert.equal((await w.messages()).at(-1).kind, 'preview');
    assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).getAttribute('aria-busy'), 'true');
    await w.publish(model({ time: .75, autoPreview: false, duration: 1, frame: last, videoWanted: true, busy: true }));
    assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).getAttribute('aria-busy'), 'true');
    await w.publish(model({ time: .75, autoPreview: false, duration: 1, frame: last, error: 'The video render failed: x' }));
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).getAttribute('aria-busy'), 'false');
    await w.publish(model({ time: .75, autoPreview: false, duration: 1, frame: last, video: video({ duration: 1 }) }));
    await page.waitForFunction(() => !!document.querySelector('video') && !(document.querySelector('video') as HTMLVideoElement).style.visibility);
    assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), true);
    // A scene without plays has no positions to step to; an outdated scene waits for the next job.
    for (const blocked of [model({ duration: 0, frame: last }), model({ job: undefined, frame: { ...last, outdated: true } })]) {
      await w.publish(blocked);
      assert.equal(await page.getByRole('button', { name: 'Next frame', exact: true }).isDisabled(), true);
    }
    assert.equal(await page.locator('.watermark').innerText(), 'OUTDATED');
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});

test('in a skipped part, the preview shows a frame; playback goes over the skipped part', async () => {
  const w = await webview('preview'), { page } = w;
  try {
    // The 3 s video leaves out the scene time 1–2 s, so the scene has 4 s.
    const skipped = video({ duration: 4, skipped: [{ start: 1, end: 2 }] });
    await w.publish(model({ time: 2.25, duration: 4, video: skipped }));
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.style.visibility && Math.abs(v.currentTime - 1.375) < 1e-3; });
    assert.equal(await page.locator('.preview-controls .position').innerText(), '2.25 s / 4.00 s');
    await w.send({ kind: 'seek', time: 1.5 });
    assert.equal((await w.message('frameNeeded')).time, 1.5);
    assert.equal(await page.locator('.banner').innerText(), 'This part is skipped in the video.');
    await w.publish(model({ time: 1.5, duration: 4, video: skipped, frame: await frame(page, 1.5) }));
    await page.waitForFunction(() => !!document.querySelector('.media-stage img') && !document.querySelector('video'));
    await w.send({ kind: 'seek', time: .5 });
    await page.waitForFunction(() => !!document.querySelector('video'));
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => (window as any).messages.filter((m: any) => m.kind === 'position').at(-1)?.time >= 2.5);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const played = await positions(w);
    assert.ok(played.some(t => t < 1) && played.every(t => t < 1 || t >= 2), `playback goes over the skipped part: ${played}`);
    assert.ok(await currentTime(w) < 2, 'video time');
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});

test('another file with the same scene class is another scene', async () => {
  const w = await webview('preview'), { page } = w;
  try {
    await w.publish(model({ time: 1, frame: await frame(page, 1) }));
    await page.waitForFunction(() => !!document.querySelector('.media-stage img'));
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await w.publish(model({ sceneKey: 'file:///other/scene.py#Demo', time: 2 }));
    assert.equal(await page.locator('.preview-controls .position').innerText(), '2.00 s / 3.00 s', 'the position of the other file');
    assert.equal(await page.getByRole('button', { name: 'Compare', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.media-stage img').count(), 0, 'no frame of the other file');
    assert.equal((await w.message('frameNeeded')).time, 2);
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});

test('an outdated video plays without a job, and a seek after the end is reported back clamped', async () => {
  const w = await webview('preview'), { page } = w;
  try {
    await w.publish(model({ time: 1, video: video({ outdated: true }), job: undefined, timelineOutdated: true }));
    await page.waitForFunction(() => !!document.querySelector('video') && !(document.querySelector('video') as HTMLVideoElement).style.visibility);
    assert.equal(await page.locator('.watermark').innerText(), 'OUTDATED');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => (window as any).messages.filter((m: any) => m.kind === 'position').at(-1)?.time > 1.2);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    assert.deepEqual((await w.messages()).filter(m => m.kind === 'frameNeeded'), [], 'no job, no frame requests');
    await w.publish(model({ time: 1, video: video() }));
    await w.send({ kind: 'seek', time: 9 });
    assert.equal((await w.messages()).at(-1).time, 2.75, 'the last frame of the 3 s scene');
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});
