import type { Model } from '../src/protocol';
import { button, el, listen, post, seconds } from './shared';
import { Measurement } from './measurement';
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
const controls = el('div', 'preview-controls');
const time = el('span', 'position');
const input = el('input'); input.type = 'number'; input.min = '0'; input.step = 'any'; input.setAttribute('aria-label', 'Time in seconds');
input.addEventListener('change', () => { if (model && Number.isFinite(input.valueAsNumber)) post({ kind: 'seek', generation: model.generation, time: input.valueAsNumber, immediate: true }); });
const play = button('Play', () => {
  if (!model) return;
  const intent = { generation: model.generation, request: model.position?.request ?? 0 };
  const video = active?.element;
  if (video instanceof HTMLVideoElement && ready() && active?.media.token === model?.media?.token && !active?.restoring && !video.paused) {
    video.pause(); post({ kind: 'pause', ...intent });
  } else post({ kind: model.playIntent !== undefined ? 'pause' : 'play', ...intent });
});
controls.append(play, button('Render video', () => post({ kind: 'preview' })), input, el('span', 'badge', 'MUTED'), time);
app.append(header, message, stage, controls);

type Media = NonNullable<Model['media']>;
interface Item {
  element: HTMLVideoElement | HTMLImageElement; media: Media; generation: number;
  request: number; target: number; restoring: boolean; disposed: boolean;
  callback?: number; lastTime?: number; decodedTime?: number; playIntent?: number; freshSeek?: boolean; timeout?: ReturnType<typeof setTimeout>;
}
let model: Model | undefined, active: Item | undefined, pending: Item | undefined;
let sequence = Date.now() * 1000;
const frameCallbacks = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const measurement = new Measurement(stage, controls, syncMeasurement);
function ready(): boolean { return model?.mediaReady ?? (!!model?.media && !model.busy && !model.stale && !model.media.old); }
function syncMeasurement(): void {
  const item = active, element = item?.element;
  const usable = ready() && item?.media.token === model?.media?.token && !item?.restoring && !(element instanceof HTMLVideoElement && element.seeking);
  if (element instanceof HTMLVideoElement) element.controls = usable && !measurement.enabled;
  measurement.setTarget(usable && element && item?.media.frame ? { element, frame: item.media.frame, token: item.media.token } : undefined);
  play.disabled = !model?.scene || model.canPlay === false || !!model.media?.old;
  play.textContent = element instanceof HTMLVideoElement && !element.paused ? 'Pause' : model?.playIntent !== undefined && !(usable && element instanceof HTMLVideoElement) ? 'Preparing playback…' : 'Play';
}
function discard(item?: Item): void {
  if (!item) return;
  item.disposed = true; clearTimeout(item.timeout);
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
  time.textContent = seconds(value); item.lastTime = value;
  if (!ready() || item.media.token !== model?.media?.token || item.request !== model.position?.request) return;
  post({ kind: 'playback', token: item.media.token, time: value, currentTime: video.currentTime, playing: !video.paused,
    sequence: tick(), seekSequence: item.request });
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
  if (model?.playIntent !== undefined && model.playIntent !== item.playIntent) {
    item.playIntent = model.playIntent;
    void item.element.play().catch(() => { status.textContent = 'Press Play to start playback'; });
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
  time.textContent = item.media.capture?.time === null ? 'End state' : item.media.capture ? seconds(item.media.capture.time!) : '';
  const request = model.position?.request ?? 0;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (active === item && !item.disposed) {
      post({ kind: 'displayed', token: item.media.token, request, sequence: tick() });
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
    element.controls = true; element.muted = true; element.preload = 'auto'; element.playsInline = true;
    element.addEventListener('loadedmetadata', () => seek(item));
    for (const event of ['loadeddata', 'canplay', 'progress', 'seeked']) element.addEventListener(event, () => { seek(item); showDecoded(item); });
    element.addEventListener('seeking', syncMeasurement);
    element.addEventListener('timeupdate', () => { if (!frameCallbacks) emit(item, element.currentTime); });
    element.addEventListener('play', syncMeasurement);
    element.addEventListener('pause', () => {
      if (!item.disposed && !item.restoring && item === active) {
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
  const previousIntent = model?.playIntent;
  model = m.model;
  title.textContent = model.scene || 'Manim Cue'; status.textContent = model.status;
  message.textContent = model.error ?? model.pairing; message.hidden = !message.textContent;
  message.classList.toggle('warning', !!message.textContent);
  if (document.activeElement !== input) input.value = String(model.position?.time ?? 0);
  input.disabled = !(model.canSeek ?? !!model.timeline);
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
  syncWatermark(); syncMeasurement();
});
post({ kind: 'ready' });
