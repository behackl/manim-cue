import type { Model } from '../src/protocol';
import { button, el, listen, post, seconds } from './shared';
import { Measurement } from './measurement';
import type { Size } from '../src/measurement';
const app = document.getElementById('app')!; app.classList.add('preview-app');
const header = el('header', 'preview-header');
const title = el('strong', 'scene-name', 'Manim Cue');
const status = el('span', 'muted'); header.append(title, status);
const message = el('div', 'banner');
const stage = el('div', 'media-stage');
const empty = el('div', 'preview-empty');
empty.append(el('div', 'empty-icon', '▷'), el('h2', '', 'Timeline first. Pixels next.'), el('p', '', 'The executed timeline appears without a video. A separate render can supply a muted preview.'));
const image = el('img'); image.alt = 'Separately rendered final still'; image.hidden = true;
const watermark = el('div', 'watermark', 'OLD PREVIEW · UNLINKED'); watermark.hidden = true;
stage.append(empty, image, watermark);
const controls = el('div', 'preview-controls');
const time = el('span', 'position');
controls.append(button('Render preview', () => post({ kind: 'preview' })), el('span', 'badge', 'MUTED PROTOTYPE'), time);
app.append(header, message, stage, controls);

interface Movie {
  video: HTMLVideoElement; token: string; request: number; target: number; frame?: Size;
  restoring: boolean; disposed: boolean; callback?: number; lastTime?: number;
}
let model: Model | undefined, active: Movie | undefined, pending: Movie | undefined;
let imageToken = '', decodedImageToken = '', sequence = Date.now() * 1000;
const frameCallbacks = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const measurement = new Measurement(stage, controls, syncMeasurement);
function syncMeasurement(): void {
  const media = model?.media;
  const fresh = !!media && !model?.busy && !model?.stale && !media.old;
  if (active) active.video.controls = fresh && active.token === media?.token && !measurement.enabled;
  const movie = fresh && active?.token === media?.token && !active?.restoring && !active?.video.seeking ? active : undefined;
  const element = movie?.video ?? (fresh && media?.kind === 'image' && decodedImageToken === media.token && !image.hidden ? image : undefined);
  const frame = movie ? movie.frame : media?.frame;
  measurement.setTarget(element && frame && media ? { element, frame, token: media.token } : undefined);
}
function discard(movie?: Movie): void {
  if (!movie) return;
  movie.disposed = true;
  if (movie.callback !== undefined) movie.video.cancelVideoFrameCallback(movie.callback);
  movie.video.pause(); movie.video.removeAttribute('src'); movie.video.load(); movie.video.remove();
}
function emit(movie: Movie, value: number): void {
  if (movie.disposed || movie !== active || movie.restoring || movie.video.seeking || !Number.isFinite(value)) return;
  time.textContent = seconds(value); movie.lastTime = value;
  if (!model?.linked || model.busy || model.media?.old || movie.token !== model.media?.token || movie.request !== model.position?.request) return;
  sequence = Math.max(sequence + 1, Date.now() * 1000);
  post({ kind: 'playback', token: movie.token, time: value, currentTime: movie.video.currentTime,
    sequence, seekSequence: movie.request });
}
function frames(movie: Movie): void {
  if (!frameCallbacks || movie.disposed) return;
  const request = movie.request;
  movie.callback = movie.video.requestVideoFrameCallback((_now, metadata) => {
    // An old callback/initial frame must not acknowledge a newer seek.
    if (request === movie.request && (!movie.video.paused ||
      Math.abs(metadata.mediaTime - movie.video.currentTime) <= 1 / (model?.media?.rate || 30) + .002)) emit(movie, metadata.mediaTime);
    frames(movie);
  });
}
function showDecoded(movie: Movie): void {
  if (movie.disposed || !movie.restoring || movie.video.seeking || movie.video.readyState < 2) return;
  if (Math.abs(movie.video.currentTime - movie.target) > .00001) {
    // Metadata alone can precede a usable seek range. Wait for loaded data/progress
    // rather than allowing an early seek to be silently clamped to zero.
    for (let i = 0; i < movie.video.seekable.length; i++) {
      if (movie.target >= movie.video.seekable.start(i) && movie.target <= movie.video.seekable.end(i)) {
        movie.video.currentTime = movie.target; break;
      }
    }
    return;
  }
  movie.restoring = false;
  if (pending === movie) {
    // Keep the previous paused video visible until the replacement has decoded the
    // requested position. Never expose the new video's initial frame-zero load.
    discard(active); active = movie; pending = undefined;
    movie.video.style.visibility = ''; movie.video.style.position = '';
    movie.video.controls = !model?.busy && !model?.media?.old;
    image.hidden = true; empty.hidden = true;
  }
  watermark.hidden = !model?.media?.old;
  syncMeasurement();
  if (!frameCallbacks) emit(movie, movie.video.currentTime);
}
function seek(movie: Movie): void {
  if (movie.disposed || !model || movie.token !== model.media?.token || !Number.isFinite(movie.video.duration)) return;
  const request = model.position?.request ?? 0;
  if (movie.request === request || (movie.request >= 0 && !model.linked)) return;
  movie.request = request;
  movie.target = Math.max(0, Math.min(model.position?.time ?? 0, Math.max(0, movie.video.duration - .000001)));
  movie.restoring = true; movie.video.pause();
  if (movie.callback !== undefined) movie.video.cancelVideoFrameCallback(movie.callback);
  frames(movie);
  showDecoded(movie); syncMeasurement();
}
function createMovie(uri: string, token: string): Movie {
  const video = el('video'); video.controls = true; video.muted = true; video.preload = 'auto'; video.playsInline = true;
  video.style.visibility = 'hidden'; video.style.position = 'absolute';
  const movie: Movie = { video, token, frame: model?.media?.frame, request: -1, target: 0, restoring: true, disposed: false };
  video.addEventListener('loadedmetadata', () => seek(movie));
  video.addEventListener('loadeddata', () => showDecoded(movie));
  video.addEventListener('canplay', () => showDecoded(movie));
  video.addEventListener('progress', () => showDecoded(movie));
  video.addEventListener('seeking', syncMeasurement);
  video.addEventListener('seeked', () => { showDecoded(movie); syncMeasurement(); });
  video.addEventListener('timeupdate', () => { if (!frameCallbacks) emit(movie, video.currentTime); });
  video.addEventListener('pause', () => { if (movie.lastTime !== undefined) emit(movie, movie.lastTime); });
  video.addEventListener('error', () => {
    if (!movie.disposed && token === model?.media?.token) post({ kind: 'mediaError', token, message: video.error?.message || 'This VS Code build could not decode the preview.' });
  });
  stage.insertBefore(video, watermark); video.src = uri; video.load();
  return movie;
}
image.addEventListener('load', () => {
  if (model?.media?.kind !== 'image' || model.media.token !== imageToken) return;
  discard(active); discard(pending); active = pending = undefined;
  decodedImageToken = imageToken;
  empty.hidden = true; image.hidden = false; time.textContent = ''; syncMeasurement();
});
image.addEventListener('error', () => { if (imageToken) post({ kind: 'mediaError', token: imageToken, message: 'The preview image could not be loaded.' }); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { active?.video.pause(); pending?.video.pause(); } });
listen(m => {
  if (m.kind !== 'state') return;
  model = m.model;
  title.textContent = model.scene || 'Manim Cue'; status.textContent = model.status;
  message.textContent = model.pairing; message.hidden = !model.pairing;
  message.classList.toggle('warning', !!model.media && !model.linked);
  if (model.busy || model.stale || model.media?.old) active?.video.pause();
  const media = model.media;
  if (!media) {
    discard(active); discard(pending); active = pending = undefined;
    image.hidden = true; imageToken = ''; image.removeAttribute('src'); empty.hidden = false; time.textContent = '';
  } else if (media.kind === 'image') {
    if (imageToken !== media.token) { decodedImageToken = ''; imageToken = media.token; image.src = media.uri; }
  } else {
    if (media.token !== active?.token && media.token !== pending?.token) {
      discard(pending); pending = createMovie(media.uri, media.token);
    }
    const movie = pending?.token === media.token ? pending : active;
    if (movie && !model.busy && !media.old) seek(movie);
    if (active) active.video.controls = !model.busy && !media.old && active.token === media.token;
  }
  watermark.hidden = !media?.old && !(pending && (active || !image.hidden));
  syncMeasurement();
});
post({ kind: 'ready' });
