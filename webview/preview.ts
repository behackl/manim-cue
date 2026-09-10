import type { Model } from '../src/protocol';
import { button, el, listen, post } from './shared';
import { Measurement } from './measurement';
import { Comparison } from './comparison';
import { ExportDialog } from './export-dialog';
const app = document.getElementById('app')!; app.classList.add('preview-app');
const header = el('header', 'preview-header');
const title = el('strong', 'scene-name', 'Manim Cue');
const status = el('span', 'muted'); header.append(title, status);
const message = el('div', 'banner');
const stage = el('div', 'media-stage');
const empty = el('div', 'preview-empty');
empty.append(el('div', 'empty-icon', '▷'), el('h2', '', 'Your current frame'), el('p', '', 'Save a Scene to update its selected frame. A complete movie follows when you stop editing.'));
const watermark = el('div', 'watermark', 'OLD PREVIEW'); watermark.hidden = true;
stage.append(empty, watermark);
stage.tabIndex = 0; stage.setAttribute('aria-label', 'Scene preview. Space to play or pause; left and right to step frames.');
const scrubber = el('input', 'preview-scrubber'); scrubber.type = 'range'; scrubber.min = '0'; scrubber.max = '0'; scrubber.setAttribute('aria-label', 'Preview position');
let scrubbing = false;
scrubber.addEventListener('pointerdown', () => { scrubbing = true; });
scrubber.addEventListener('pointerup', () => { scrubbing = false; });
scrubber.addEventListener('pointercancel', () => { scrubbing = false; });
for (const event of ['input', 'change']) scrubber.addEventListener(event, () => {
  if (model && !scrubber.disabled) post({ kind: 'seek', generation: model.generation, time: scrubber.valueAsNumber, immediate: event === 'change' });
});
const controls = el('div', 'preview-controls');
const time = el('span', 'position');
const icons = { play: 'M5 3L17 10L5 17Z', pause: 'M5 3H8V17H5ZM12 3H15V17H12Z', previous: 'M3 3H5V17H3ZM17 3L6 10L17 17Z', next: 'M15 3H17V17H15ZM3 3L14 10L3 17Z' };
function iconButton(label: string, icon: string, action: () => void): HTMLButtonElement {
  const b = button('', action, label); b.className = 'icon-button'; b.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', icon); svg.append(p); b.append(svg); return b;
}
const render = button('Render video', () => post({ kind: 'preview' }), 'Prepare a movie without starting playback');
const play = iconButton('Play', icons.play, () => {
  if (!model) return;
  const intent = { generation: model.generation, request: model.position?.request ?? 0 };
  const video = active?.element;
  if (video instanceof HTMLVideoElement && ready() && active?.media.token === model?.media?.token && !active?.restoring && !video.paused) {
    video.pause(); post({ kind: 'pause', ...intent });
  } else {
    if (model.playIntent === undefined && measurement.enabled) measurement.setEnabled(false);
    post({ kind: model.playIntent !== undefined ? 'pause' : 'play', ...intent });
  }
});
const step = (direction: -1 | 1) => { if (model) post({ kind: 'step', generation: model.generation, direction }); };
const previous = iconButton('Previous frame', icons.previous, () => step(-1)); previous.title += ' (Left)';
const next = iconButton('Next frame', icons.next, () => step(1)); next.title += ' (Right)';
function openExport(): void {
  if (active?.element instanceof HTMLVideoElement) active.element.pause();
  post({ kind: 'openExport', token: active?.media.token, time: active?.lastTime ?? model?.position?.time ?? 0 });
}
const exportButton = button('Export…', openExport, 'Save a frame, video or timeline; or render a new video');
controls.append(render, play, time, previous, next, exportButton);
app.append(header, message, stage, scrubber, controls);

type Media = NonNullable<Model['media']>;
interface Item {
  element: HTMLVideoElement | HTMLImageElement; media: Media; generation: number;
  request: number; target: number; restoring: boolean; disposed: boolean; acknowledged?: boolean;
  callback?: number; lastTime?: number; decodedTime?: number; playIntent?: number; freshSeek?: boolean; timeout?: ReturnType<typeof setTimeout>;
  loopTimer?: ReturnType<typeof setTimeout>; repeating?: boolean;
}
let model: Model | undefined, active: Item | undefined, pending: Item | undefined;
let sequence = Date.now() * 1000;
const frameCallbacks = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const measurement = new Measurement(stage, controls, syncMeasurement, () => comparison.disable());
const comparison = new Comparison(stage, controls, () => { if (measurement.enabled) measurement.setEnabled(false); });
const exportDialog = new ExportDialog(openExport, controls);
const settings = iconButton('Cue settings', 'M8 1H12L13 4L16 3L18 6L16 9L19 10L18 14L15 14L14 17L10 19L8 16L5 17L2 14L4 11L1 9L3 5L6 5ZM10 6A4 4 0 1 0 10 14A4 4 0 1 0 10 6Z', () => post({ kind: 'settings' }));
settings.querySelector('path')!.setAttribute('fill-rule', 'evenodd'); controls.append(settings);
function ready(): boolean { return model?.mediaReady ?? (!!model?.media && !model.busy && !model.stale && !model.media.old); }
function syncMeasurement(): void {
  const item = active, element = item?.element;
  const usable = ready() && item?.media.token === model?.media?.token && !item?.restoring && !(element instanceof HTMLVideoElement && element.seeking);
  if (element instanceof HTMLVideoElement) element.controls = false;
  exportButton.disabled = !model?.scene || !!model?.exportState?.busy || !!item && (!item.acknowledged || item.restoring);
  previous.disabled = next.disabled = !model?.canSeek || model.canPlay === false || !!model?.media?.old;
  render.hidden = model?.comparison?.enabled === true || model?.autoPreview !== false || model?.hasMovie === true || model?.canPlay === false;
  render.disabled = !model?.scene;
  measurement.setTarget(usable && element && item?.media.frame ? { element, frame: item.media.frame, token: item.media.token } : undefined);
  play.disabled = !model?.scene || model.canPlay === false || !!model.media?.old;
  const pausing = element instanceof HTMLVideoElement && !element.paused || model?.playIntent !== undefined;
  play.setAttribute('aria-label', pausing ? 'Pause' : 'Play'); play.title = pausing ? 'Pause (Space)' : 'Play (Space)';
  play.querySelector('path')!.setAttribute('d', pausing ? icons.pause : icons.play);
  play.setAttribute('aria-busy', String(model?.playIntent !== undefined && !(usable && element instanceof HTMLVideoElement)));
  comparison.update(model, item ? { element: item.element, media: item.media, restoring: item.restoring || !item.acknowledged, get time() { return item.lastTime; } } : undefined);
  syncTime(); if (item) checkLoop(item);
}
function discard(item?: Item): void {
  if (!item) return;
  item.disposed = true; clearTimeout(item.timeout); clearTimeout(item.loopTimer);
  if (item.element instanceof HTMLVideoElement) {
    if (item.callback !== undefined) item.element.cancelVideoFrameCallback(item.callback);
    item.element.pause(); item.element.removeAttribute('src'); item.element.load();
  } else item.element.removeAttribute('src');
  item.element.remove();
}
function tick(): number { return sequence = Math.max(sequence + 1, Date.now() * 1000); }
function emit(item: Item, value: number): void {
  const video = item.element;
  if (!(video instanceof HTMLVideoElement) || item.disposed || item !== active || item.restoring || video.seeking || !Number.isFinite(value)) return;
  if (checkLoop(item, value)) return;
  item.lastTime = value; syncTime();
  if (!ready() || item.media.token !== model?.media?.token || item.request !== model.position?.request) return;
  post({ kind: 'playback', token: item.media.token, time: value, currentTime: video.currentTime, playing: !video.paused,
    sequence: tick(), seekSequence: item.request });
}
function repeat(item: Item, start: number): void {
  item.restoring = true; item.repeating = true; item.target = start;
  item.decodedTime = undefined; item.freshSeek = true;
  (item.element as HTMLVideoElement).pause(); showDecoded(item);
}
// Use the movie's checked presentation boundaries. Seeking may pause briefly at a
// wrap; never stretch timestamps or start a Python job for looping.
function checkLoop(item: Item, presented?: number): boolean {
  clearTimeout(item.loopTimer);
  const video = item.element, range = model?.media?.loop;
  if (!(video instanceof HTMLVideoElement) || item.disposed || item !== active || item.restoring || video.seeking || video.paused ||
    !ready() || !model?.linked || item.media.token !== model.media?.token || !range) return false;
  if (Math.max(video.currentTime, presented ?? 0) >= range.end) {
    repeat(item, range.start); return true;
  }
  item.loopTimer = setTimeout(() => checkLoop(item), Math.max(1, (range.end - video.currentTime) * 1000 / video.playbackRate));
  return false;
}
function frames(item: Item): void {
  if (!frameCallbacks || item.disposed || !(item.element instanceof HTMLVideoElement)) return;
  const request = item.request;
  item.callback = item.element.requestVideoFrameCallback((_now, metadata) => {
    if (item.disposed || request !== item.request) return;
    const video = item.element as HTMLVideoElement;
    const tolerance = item.freshSeek && model?.media?.seekTime !== undefined ? .00001 : 1 / (item.media.rate || 30) + .002;
    if (item.restoring) {
      if (Math.abs(metadata.mediaTime - item.target) <= tolerance) item.decodedTime = metadata.mediaTime;
      showDecoded(item);
    } else if (!video.paused || Math.abs(metadata.mediaTime - video.currentTime) <= tolerance) {
      item.freshSeek = false; emit(item, metadata.mediaTime);
    }
    frames(item);
  });
}
function applyPlay(item: Item): void {
  if (item !== active || item.disposed || item.restoring || !ready() || !(item.element instanceof HTMLVideoElement)) return;
  if (model?.playIntent !== undefined && (model.playIntent !== item.playIntent || item.repeating)) {
    const range = model.media?.loop;
    if (range && (item.element.currentTime + .00001 < range.start || item.element.currentTime >= range.end)) {
      repeat(item, range.start); return;
    }
    item.repeating = false; item.playIntent = model.playIntent;
    void item.element.play().catch(() => {
      if (item.disposed || item !== active || !ready()) return;
      status.textContent = 'Press Play to start playback';
      post({ kind: 'pause', generation: model!.generation, request: item.request, token: item.media.token });
    });
  }
}
function displayed(item: Item): void {
  if (!model || item.disposed || item.media.token !== model.media?.token) return;
  // Restoring a view may show stale media, but obsolete candidates must not replace its picture.
  if (!ready() && active && active !== item) return;
  if (ready() && item.media.capture && item.media.capture.requestedTime !== model.position?.time) return;
  if (pending === item) {
    discard(active); active = item; pending = undefined;
    item.element.style.visibility = ''; item.element.style.position = '';
    item.element.hidden = false; empty.hidden = true;
  }
  item.restoring = false; clearTimeout(item.timeout);
  item.lastTime = item.media.capture?.time ?? (item.element instanceof HTMLVideoElement ? item.target : undefined);
  const request = model.position?.request ?? 0;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active === item && !item.disposed) {
      post({ kind: 'displayed', token: item.media.token, request, sequence: tick() });
      item.acknowledged = true; syncMeasurement();
    }
  }));
  syncWatermark(); syncMeasurement(); applyPlay(item);
}
function showDecoded(item: Item): void {
  const video = item.element;
  if (!(video instanceof HTMLVideoElement) || item.disposed || !item.restoring || video.seeking || video.readyState < 2) return;
  if (Math.abs(video.currentTime - item.target) > .00001) {
    for (let i = 0; i < video.seekable.length; i++) {
      if (item.target >= video.seekable.start(i) && item.target <= video.seekable.end(i)) { video.currentTime = item.target; break; }
    }
    return;
  }
  if (item.request !== model?.position?.request) return;
  displayed(item);
  if (item.decodedTime !== undefined) { item.freshSeek = false; emit(item, item.decodedTime); }
  else if (!frameCallbacks) emit(item, video.currentTime);
}
function seek(item: Item): void {
  const video = item.element;
  if (!(video instanceof HTMLVideoElement) || item.disposed || !model || item.media.token !== model.media?.token || !Number.isFinite(video.duration) || (!ready() && !!active)) return;
  const request = model.position?.request ?? 0;
  if (item.request === request) { applyPlay(item); return; }
  item.request = request;
  item.target = Math.max(0, Math.min(model.media.seekTime ?? model.position?.time ?? 0, Math.max(0, video.duration - .000001)));
  clearTimeout(item.loopTimer); item.repeating = false;
  item.restoring = true; item.freshSeek = true; item.decodedTime = undefined; video.pause();
  if (item.callback !== undefined) video.cancelVideoFrameCallback(item.callback);
  frames(item); showDecoded(item); syncMeasurement();
}
function create(media: Media): Item {
  const element = media.kind === 'video' ? el('video') : el('img');
  element.style.visibility = 'hidden'; element.style.position = 'absolute';
  const item: Item = { element, media, generation: model!.generation, request: -1, target: 0, restoring: true, disposed: false };
  const fail = (message: string) => {
    if (!item.disposed && item.media.token === model?.media?.token) post({ kind: 'mediaError', token: item.media.token, message });
  };
  item.timeout = setTimeout(() => fail('Loading the replacement preview timed out. Retry the preview.'), 15000);
  if (element instanceof HTMLVideoElement) {
    element.controls = false; element.muted = true; element.preload = 'auto'; element.playsInline = true;
    element.addEventListener('loadedmetadata', () => seek(item));
    for (const event of ['loadeddata', 'canplay', 'progress', 'seeked']) element.addEventListener(event, () => { seek(item); showDecoded(item); });
    element.addEventListener('seeking', syncMeasurement);
    element.addEventListener('timeupdate', () => { if (!frameCallbacks) emit(item, element.currentTime); });
    element.addEventListener('play', syncMeasurement);
    element.addEventListener('ended', () => {
      if (model?.playIntent !== undefined && model.media?.loop && ready() && item === active && item.media.token === model.media.token) {
        repeat(item, model.media.loop.start);
      }
    });
    element.addEventListener('pause', () => {
      if (!item.disposed && !item.restoring && item === active && !(element.ended && model?.media?.loop && model.playIntent !== undefined)) {
        post({ kind: 'pause', generation: model?.generation ?? -1, request: item.request, token: item.media.token }); if (item.lastTime !== undefined) emit(item, item.lastTime); syncMeasurement();
      }
    });
    element.addEventListener('error', () => fail(element.error?.message || 'This VS Code build could not decode the preview.'));
  } else {
    element.alt = media.capture?.time === null ? 'Scene end-state snapshot' : 'Captured scene frame';
    element.addEventListener('load', () => { void element.decode().then(() => displayed(item)).catch(() => fail('The preview image could not be decoded.')); });
    element.addEventListener('error', () => fail('The preview image could not be loaded.'));
  }
  stage.insertBefore(element, watermark); element.src = media.uri;
  if (element instanceof HTMLVideoElement) element.load();
  return item;
}
function syncTime(): void {
  const value = active?.lastTime ?? active?.media.capture?.time ?? model?.position?.time ?? 0;
  const total = active?.media.kind === 'video' ? active.media.duration
    : active?.media.token === model?.media?.token && !model?.media?.old ? model?.duration : undefined;
  time.textContent = `${active?.media.capture?.time === null ? 'End state' : value.toFixed(3) + ' s'} / ${total === undefined ? '—' : total.toFixed(3) + ' s'}`;
  scrubber.disabled = !model?.canSeek || model?.duration === undefined || model.duration <= 0 || !!model.media?.old;
  scrubber.max = String(model?.duration ?? 0); scrubber.step = String(1 / (model?.fps ?? model?.media?.rate ?? 30));
  if (!scrubbing) scrubber.value = String(value);
  scrubber.setAttribute('aria-valuetext', time.textContent);
}
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || (event.target as Element).closest('dialog, input, select, textarea, button, [contenteditable]')) return;
  if (event.key === ' ' && !play.disabled) { event.preventDefault(); if (!event.repeat) play.click(); }
  if (event.key === 'ArrowLeft' && !previous.disabled) { event.preventDefault(); previous.click(); }
  if (event.key === 'ArrowRight' && !next.disabled) { event.preventDefault(); next.click(); }
});
function syncWatermark(): void {
  const media = model?.media;
  const sameSource = !!active?.media.sourceId && active.media.sourceId === media?.sourceId;
  const old = media?.old || (active && active.media.token !== media?.token && !sameSource && active.generation !== model?.generation);
  watermark.textContent = old ? 'OLD PREVIEW' : 'UPDATING FRAME';
  watermark.hidden = !active || (!old && ((active.media.token === media?.token && ready()) || (sameSource && active.media.capture?.requestedTime === model?.position?.time)));
}
document.addEventListener('visibilitychange', () => { if (document.hidden && active?.element instanceof HTMLVideoElement) active.element.pause(); });
listen(m => {
  if (m.kind !== 'state') return;
  const previousIntent = model?.playIntent, wasComparing = model?.comparison?.enabled;
  model = m.model;
  if (model.comparison?.enabled && !wasComparing && measurement.enabled) measurement.setEnabled(false);
  title.textContent = model.scene || 'Manim Cue'; status.textContent = model.status;
  message.textContent = model.error ?? model.pairing; message.hidden = !message.textContent;
  message.classList.toggle('warning', !!message.textContent);
  const media = model.media;
  if (!media) {
    discard(active); discard(pending); active = pending = undefined;
    empty.hidden = false; time.textContent = '';
  } else {
    if (!ready() && active && pending) { discard(pending); pending = undefined; }
    if ((ready() || !active) && media.token !== active?.media.token && media.token !== pending?.media.token) { discard(pending); pending = create(media); }
    if (media.token === active?.media.token && pending) { discard(pending); pending = undefined; }
    const item = pending?.media.token === media.token ? pending : active;
    if (item?.element instanceof HTMLVideoElement) seek(item);
    if ((!ready() || (previousIntent !== undefined && model.playIntent === undefined)) && active?.element instanceof HTMLVideoElement) active.element.pause();
  }
  syncWatermark(); syncMeasurement(); exportDialog.update(model);
});
post({ kind: 'ready' });
