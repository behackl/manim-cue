import type { FrameMedia, Model, VideoMedia } from '../src/protocol';
import { button, el, listen, post } from './shared';
import { isSkipped, sceneTime, videoTime } from '../src/video-time';
import { frameIndex, videoFrameIndex, videoFrames } from '../src/transport';
import { Measurement } from './measurement';
import { Comparison } from './comparison';
import { ExportDialog } from './export-dialog';

// The preview owns the playback: the position (in scene time), play and pause, steps
// and loops. It shows the current video when the video has the position, and else asks
// the host for the frame at that position.
const app = document.getElementById('app')!; app.classList.add('preview-app');
const header = el('header', 'preview-header');
const title = el('strong', 'scene-name', 'Manim Cue');
const status = el('span', 'status'); header.append(title, status);
const message = el('div', 'banner warning');
const stage = el('div', 'media-stage');
const empty = el('div', 'preview-empty');
empty.append(el('div', 'empty-icon', '▷'), el('h2', '', 'Scene preview'), el('p', '', 'Save the scene file to update the frame, the timeline and the video.'));
const watermark = el('div', 'watermark'); watermark.hidden = true;
stage.append(empty, watermark);
stage.tabIndex = 0; stage.setAttribute('aria-label', 'Scene preview. Space plays or pauses. Left and right arrows step one frame.');
const scrubber = el('input', 'preview-scrubber'); scrubber.type = 'range'; scrubber.min = '0'; scrubber.max = '0'; scrubber.setAttribute('aria-label', 'Position');
let scrubbing = false;
scrubber.addEventListener('pointerdown', () => { scrubbing = true; });
scrubber.addEventListener('pointerup', () => { scrubbing = false; });
scrubber.addEventListener('pointercancel', () => { scrubbing = false; });
scrubber.addEventListener('input', () => { stop(); setTime(scrubber.valueAsNumber, true); });
const controls = el('div', 'preview-controls');
const clock = el('span', 'position');
const icons = { play: 'M5 3L17 10L5 17Z', pause: 'M5 3H8V17H5ZM12 3H15V17H12Z', previous: 'M3 3H5V17H3ZM17 3L6 10L17 17Z', next: 'M15 3H17V17H15ZM3 3L14 10L3 17Z' };
function iconButton(label: string, icon: string, action: () => void): HTMLButtonElement {
  const b = button('', action, label); b.className = 'icon-button'; b.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', icon); svg.append(p); b.append(svg); return b;
}
const render = button('Render video', () => post({ kind: 'preview' }), 'Render the video without playing it');
const play = iconButton('Play', icons.play, () => { if (playing || playWanted) pause(); else start(); });
const previous = iconButton('Previous frame', icons.previous, () => step(-1)); previous.title += ' (Left)';
const next = iconButton('Next frame', icons.next, () => step(1)); next.title += ' (Right)';
const exportButton = button('Export…', openExport, 'Save the frame, the video or the timeline');
controls.append(render, play, clock, previous, next, exportButton);
app.append(header, message, stage, scrubber, controls);
const measurement = new Measurement(stage, controls, sync, () => comparison.disable());
const comparison = new Comparison(stage, controls, enabled => { if (enabled) { pause(); if (measurement.enabled) measurement.setEnabled(false); } sync(); });
const exportDialog = new ExportDialog(openExport, controls);
const settings = iconButton('Settings', 'M8 1H12L13 4L16 3L18 6L16 9L19 10L18 14L15 14L14 17L10 19L8 16L5 17L2 14L4 11L1 9L3 5L6 5ZM10 6A4 4 0 1 0 10 14A4 4 0 1 0 10 6Z', () => post({ kind: 'settings' }));
settings.querySelector('path')!.setAttribute('fill-rule', 'evenodd'); controls.append(settings);

type Media = FrameMedia | VideoMedia;
interface Item { media: Media; element: HTMLImageElement | HTMLVideoElement; disposed?: boolean }
const isVideo = (media: Media): media is VideoMedia => 'skipped' in media;
const frameCallbacks = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let model: Model | undefined, scene: string | undefined;
let time = 0, playing = false, playWanted = false;
/** The last frame request, so that each position is asked for once in each job. */
let requested: { job?: string; time: number } | undefined;
let shown: Item | undefined, loading: Item | undefined, loadError: string | undefined;
const failed = new Set<string>();

const duration = () => model?.timeline?.duration;
const fps = () => model?.fps ?? 30;
function lastFrame(): number {
  const d = duration();
  return d === undefined ? Infinity : Math.max(0, (videoFrames(d, fps()) - 1) / fps());
}
function currentVideo(): VideoMedia | undefined {
  const video = model?.video;
  return video && !video.outdated && !failed.has(video.id) && !comparison.enabled ? video : undefined;
}
/** The result for the position: the current video, or else a current frame for it. */
function wanted(): Media | undefined {
  const video = currentVideo();
  if (video && (playing || !isSkipped(video.skipped, time))) return video;
  const frame = model?.frame;
  return frame && !frame.outdated && !failed.has(frame.id) && frame.requestedTime === time ? frame : undefined;
}
// Seek to the middle of a frame: the timestamps in the file can differ slightly from the
// nominal frame times.
const videoPosition = (video: VideoMedia, at: number) => videoTime(video.skipped, at) + .5 / video.rate;
function setTime(value: number, report: boolean): void {
  time = Math.max(0, Math.min(value, lastFrame()));
  if (report) post({ kind: 'position', time });
  sync();
}
function step(direction: -1 | 1): void {
  if (previous.disabled) return;
  stop(); setTime((frameIndex(time, fps()) + direction) / fps(), true);
}
function start(): void {
  if (!model?.job) return;
  comparison.disable(); if (measurement.enabled) measurement.setEnabled(false);
  if (!currentVideo()) { playWanted = true; post({ kind: 'preview' }); sync(); return; }
  playWanted = false;
  const loop = model.loop;
  if (loop && (time < loop.start || time >= loop.end)) setTime(loop.start, true);
  else if (time >= lastFrame()) setTime(0, true);
  playing = true; sync();
}
function stop(): boolean {
  if (!playing && !playWanted) return false;
  playing = playWanted = false;
  if (shown?.element instanceof HTMLVideoElement) shown.element.pause();
  return true;
}
function pause(): void { if (stop()) { post({ kind: 'position', time }); sync(); } }
/** The video shows a new frame while it plays. */
function presented(item: Item, mediaTime: number): void {
  if (!playing || item !== shown || !isVideo(item.media)) return;
  const video = item.media, loop = model?.loop;
  let at = videoFrameIndex(sceneTime(video.skipped, mediaTime), video.rate) / video.rate;
  if (loop && at >= loop.end - 1e-6) { at = loop.start; (item.element as HTMLVideoElement).currentTime = videoPosition(video, at); }
  time = at; post({ kind: 'position', time }); sync();
}
function openExport(): void {
  pause();
  post({ kind: 'openExport', time, video: !!shown && isVideo(shown.media) && shown.media.id === wanted()?.id });
}
function discard(item?: Item): void {
  if (!item) return;
  item.disposed = true;
  if (item.element instanceof HTMLVideoElement) { item.element.pause(); item.element.removeAttribute('src'); item.element.load(); }
  item.element.remove();
}
function create(media: Media): Item {
  const element = isVideo(media) ? el('video') : el('img'), item: Item = { media, element };
  element.style.visibility = 'hidden'; element.style.position = 'absolute';
  const ready = () => {
    if (item.disposed || loading !== item) return;
    discard(shown); shown = item; loading = undefined; loadError = undefined;
    element.style.visibility = element.style.position = ''; empty.hidden = true; sync();
  };
  const fail = (text: string) => {
    if (item.disposed) return;
    failed.add(media.id); loadError = text;
    if (loading === item) { discard(item); loading = undefined; }
    sync();
  };
  if (element instanceof HTMLVideoElement) {
    const video = media as VideoMedia;
    element.muted = true; element.preload = 'auto'; element.playsInline = true; element.controls = false;
    element.addEventListener('loadedmetadata', () => { element.currentTime = videoPosition(video, time); }, { once: true });
    element.addEventListener('seeked', ready);
    element.addEventListener('ended', () => {
      if (!playing || item !== shown) return;
      if (model?.loop) { element.currentTime = videoPosition(video, model.loop.start); void element.play(); return; }
      playing = false; setTime(lastFrame(), true);
    });
    element.addEventListener('error', () => fail('VS Code cannot play this video.'));
    if (frameCallbacks) {
      const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (item.disposed) return;
        presented(item, metadata.mediaTime); element.requestVideoFrameCallback(frame);
      };
      element.requestVideoFrameCallback(frame);
    } else element.addEventListener('timeupdate', () => presented(item, element.currentTime));
  } else {
    element.alt = (media as FrameMedia).time === null ? 'Last frame of the scene' : 'Scene frame';
    element.addEventListener('load', () => { void element.decode().then(ready, () => fail('The frame did not load. Refresh to try again.')); });
    element.addEventListener('error', () => fail('The frame did not load. Refresh to try again.'));
  }
  stage.insertBefore(element, watermark); element.src = media.uri;
  return item;
}
/** Shows the result for the position, asks for a missing frame, and updates the controls. */
function sync(): void {
  if (!model) return;
  const want = wanted(), video = currentVideo();
  if (!want && model.job && (requested?.job !== model.job || requested.time !== time)) {
    requested = { job: model.job, time }; post({ kind: 'frameNeeded', time });
  }
  // Without anything shown yet, an outdated result or a frame for another time is better than nothing.
  const media = want ?? (shown ? undefined : model.frame ?? model.video);
  if (loading && loading.media.id !== media?.id) { discard(loading); loading = undefined; }
  if (media && shown?.media.id !== media.id && !loading) loading = create(media);
  const current = !!shown && shown.media.id === want?.id;
  const element = shown?.element;
  if (element instanceof HTMLVideoElement && shown && isVideo(shown.media)) {
    if (!current || !playing) {
      element.pause();
      const target = videoPosition(shown.media, time);
      if (current && Math.abs(element.currentTime - target) > 1e-4) element.currentTime = target;
    } else if (element.paused) {
      void element.play().catch(() => { playing = false; status.textContent = 'Press Play to start.'; sync(); });
    }
  }
  empty.hidden = !!shown || !!loading;
  watermark.textContent = shown?.media.outdated ? 'OUTDATED' : 'UPDATING FRAME';
  watermark.hidden = !shown || !shown.media.outdated && current;
  const last = current && !isVideo(shown!.media) && shown!.media.time === null;
  const notice = last ? 'The scene ends before this time. This is its last frame.'
    : video && !playing && isSkipped(video.skipped, time) ? 'This part is skipped in the video.' : '';
  message.textContent = model.error ?? loadError ?? notice; message.hidden = !message.textContent;
  const d = duration();
  clock.textContent = `${last ? 'Last frame' : time.toFixed(2) + ' s'} / ${d === undefined ? '—' : d.toFixed(2) + ' s'}`;
  scrubber.disabled = !model.job || !d; scrubber.max = String(d ?? 0); scrubber.step = String(1 / fps());
  if (!scrubbing) scrubber.value = String(time);
  scrubber.setAttribute('aria-valuetext', clock.textContent);
  previous.disabled = next.disabled = play.disabled = !model.job || d === 0;
  render.hidden = model.autoPreview || !!video || comparison.enabled || d === 0;
  render.disabled = !model.scene;
  exportButton.disabled = !model.scene || !!model.exportState?.busy;
  const pausing = playing || playWanted;
  play.setAttribute('aria-label', pausing ? 'Pause' : 'Play'); play.title = pausing ? 'Pause (Space)' : 'Play (Space)';
  play.querySelector('path')!.setAttribute('d', pausing ? icons.pause : icons.play);
  play.setAttribute('aria-busy', String(playWanted));
  measurement.setTarget(current && element && !(element instanceof HTMLVideoElement && element.seeking)
    ? { element, frame: shown!.media.frame, token: shown!.media.id } : undefined);
  comparison.update(model.reference, shown && { element: shown.element, media: shown.media, current });
}
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || (event.target as Element).closest('dialog, input, select, textarea, button, [contenteditable]')) return;
  if (event.key === ' ' && !play.disabled) { event.preventDefault(); if (!event.repeat) play.click(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
listen(m => {
  if (m.kind === 'seek') { stop(); setTime(m.time, false); return; }
  if (m.kind === 'step') { step(m.direction); return; }
  if (m.kind !== 'state') return;
  model = m.model;
  if (model.scene !== scene) {
    const before = scene; scene = model.scene; time = model.time; playing = playWanted = false; requested = loadError = undefined;
    if (before !== undefined) comparison.disable();
    failed.clear(); discard(shown); discard(loading); shown = loading = undefined;
  }
  // The host sends the same results with a newer outdated flag.
  for (const item of [shown, loading]) {
    const media = [model.frame, model.video, model.reference].find(media => media?.id === item?.media.id);
    if (item && media) item.media = media;
  }
  title.textContent = model.scene || 'Manim Cue'; status.textContent = model.status; status.classList.toggle('busy', model.busy);
  if (!model.timelineOutdated && time > lastFrame()) setTime(lastFrame(), true);
  if (playWanted && currentVideo()) start(); else sync();
  exportDialog.update(model);
});
post({ kind: 'ready' });
