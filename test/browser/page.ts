import { readFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright-core';
import type { HostMessage, Model } from '../../src/protocol';
import type { Timeline } from '../../src/timeline';

/** A webview page with a fake VS Code API. `messages()` returns what the webview sent. */
export async function webview(script: 'preview' | 'timeline', viewport = { width: 900, height: 600 }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const movie = await readFile('test/fixtures/seek.mp4');
  // The fixture is a 3 s video at 4 fps with one colour for each frame.
  await page.route('https://cue.test/*.mp4', route => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : movie.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: movie.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${movie.length}` } : {}) } });
  });
  await page.setContent('<main id="app"></main>');
  await page.addStyleTag({ content: await readFile('webview/styles.css', 'utf8') });
  await page.addScriptTag({ content: 'window.messages=[];window.savedState={};window.acquireVsCodeApi=()=>({getState:()=>window.savedState,setState:s=>{window.savedState=s},postMessage:m=>window.messages.push(m)});' });
  await page.addScriptTag({ content: await readFile(`dist/${script}.js`, 'utf8') });
  const send = (message: HostMessage) => page.evaluate(message => new Promise<void>(resolve => {
    window.addEventListener('message', () => setTimeout(resolve), { once: true }); window.postMessage(message, '*');
  }), message);
  return {
    browser, page, errors, send,
    publish: (model: Model) => send({ kind: 'state', model }),
    messages: (): Promise<any[]> => page.evaluate(() => (window as any).messages),
    /** Waits for a message of `kind` that `check` accepts, and returns it. */
    message: async (kind: string, check: string = 'true') => (await page.waitForFunction(([kind, check]) =>
      (window as any).messages.findLast((m: any) => m.kind === kind && new Function('m', `return ${check}`)(m)), [kind, check])).jsonValue() as Promise<any>,
  };
}
export const timeline = (duration: number) => ({ schema: 'manim.timeline', version: 1, mode: 'render', scene: 'Demo', backend: 'CairoRenderer',
  frame_rate: 4, duration, ended_early: false, source: null, entries: [] }) as Timeline;
export const model = (changes: Partial<Model> = {}): Model => ({ scene: 'Demo', sceneKey: 'file:///scene.py#Demo', status: 'Up to date', busy: false, pythonProblem: false, autoRender: true, videoWanted: false, fps: 4,
  job: 'job-1', time: 0, timelineOutdated: false, timeline: timeline(3), timelineId: 'timeline-1', duration: 3, ...changes });
export const video = (changes: Partial<NonNullable<Model['video']>> = {}): NonNullable<Model['video']> => ({ id: 'video', uri: 'https://cue.test/a.mp4',
  outdated: false, frame: { width: 8, height: 4 }, duration: 3, rate: 4, skipped: [], ...changes });
/** A frame as a data URL of one colour. */
export async function frame(page: Page, requestedTime: number, color = '#f00', changes: Partial<NonNullable<Model['frame']>> = {}): Promise<NonNullable<Model['frame']>> {
  const uri = await page.evaluate(color => { const c = document.createElement('canvas'); c.width = 400; c.height = 200;
    const g = c.getContext('2d')!; g.fillStyle = color; g.fillRect(0, 0, 400, 200); return c.toDataURL(); }, color);
  return { id: `frame-${requestedTime}-${color}`, uri, outdated: false, frame: { width: 8, height: 4 }, requestedTime, time: requestedTime, ...changes };
}
