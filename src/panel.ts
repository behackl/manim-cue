import * as vscode from 'vscode';
import type { Model } from './protocol';
import type { PreviewResult } from './jobs';
import type { Session } from './session';
import { frameIndex, videoFrames } from './transport';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const optional = <T>(x: unknown, check: (x: unknown) => x is T): x is T | undefined => x === undefined || check(x);
const text = (x: unknown): x is string => typeof x === 'string';

/** The state that both webviews show. */
export function model(s: Session, webview?: vscode.Webview): Model {
  const uri = (file: string) => webview ? webview.asWebviewUri(vscode.Uri.file(file)).toString() : '';
  const frame = (r: PreviewResult) => ({ width: r.profile.frameWidth, height: r.profile.frameHeight });
  const preview = s.preview, media = preview?.media, fresh = !!preview && !preview.outdated;
  const ready = s.mediaReady(), stale = !!s.timeline?.outdated, video = s.currentVideo();
  const linked = fresh && !stale && media?.kind === 'video' && !s.mediaError;
  let pairing = s.mediaError ?? '';
  if (media && !fresh) pairing = 'Old preview — source changed';
  else if (media?.capture?.time === null) pairing = 'End state — requested frame unavailable';
  else if (media?.capture && s.frameSequence !== s.seekSequence) pairing = 'Updating frame at the selected time…';
  const selection = s.selection();
  const cfg = vscode.workspace.getConfiguration('manimCue', s.target?.uri);
  const profile = s.timeline?.profile;
  return {
    exportState: s.exports.snapshot(webview),
    generation: s.generation, scene: s.target?.scene ?? '',
    status: (s.exports.nativeBusy ? 'Export rendering — automatic previews paused' : s.status) + (s.positionClamped ? ' — position clamped to scene end' : ''),
    busy: s.busy, stale, error: s.error, autoPreview: s.autoPreview, python: s.pythonInUse,
    timeline: s.timeline?.timeline, selected: s.selected, selectedEvents: s.selectedEvents,
    selection: selection && { ...selection.range, enabled: s.loopEnabled && !stale, available: selection.available },
    linked, pairing, playbackTime: s.playbackTime,
    position: { time: s.desiredTime, request: s.seekSequence }, playIntent: s.playIntent,
    comparison: { enabled: s.comparing, pending: !!s.pinRequest, reference: s.reference && {
      uri: uri(s.reference.media.path), token: s.reference.media.path, kind: 'image', old: false, duration: 0, rate: s.reference.media.rate,
      capture: s.reference.media.capture, sourceId: s.reference.directory, sourceHash: s.reference.sourceHash, frame: frame(s.reference),
    } },
    duration: video ? video.media.duration : !stale ? s.timeline?.timeline.duration : undefined,
    fps: s.job?.options.fps ?? cfg.get<number>('frameRate', 30), previewWidth: cfg.get<number>('previewWidth', 960), hasMovie: !!video,
    canSeek: !!s.target, canPlay: stale || !s.timeline || s.timeline.timeline.duration > 0, mediaReady: ready,
    profile: profile && `Cairo · ${profile.fps} fps · ${profile.width}×${profile.height} · seed ${profile.seed}`,
    media: preview && media && { uri: uri(media.path), kind: media.kind, token: media.path, old: !fresh, duration: media.duration, rate: media.rate,
      capture: media.capture, sourceId: preview.directory, sourceHash: preview.sourceHash, frame: frame(preview),
      seekTime: media.kind === 'video' ? frameIndex(s.desiredTime, media.rate, videoFrames(media.duration, media.rate)) / media.rate : undefined,
      loop: linked && s.loopEnabled ? selection?.loop : undefined },
  };
}

/** Checks a message from a webview and passes it to the session. */
export async function receive(s: Session, data: unknown, origin: 'timeline' | 'preview'): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const m = data as Record<string, unknown>, current = m.generation === s.generation;
  switch (m.kind) {
    case 'ready': s.views.update(); return;
    case 'refresh': await s.refresh(); return;
    case 'cancel': s.cancel(); return;
    case 'preview': await s.renderVideo(); return;
    case 'export': await s.exportTimeline(); return;
    case 'logs': await vscode.commands.executeCommand('manimCue.logs'); return;
    case 'doctor': await vscode.commands.executeCommand('manimCue.doctor'); return;
    case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${s.extensionId}`); return;
    case 'seek': if (current && finite(m.time)) s.seek(m.time, m.immediate === true); return;
  }
  if (origin === 'timeline') {
    if (!current) return;
    if (m.kind === 'loopSelection' && typeof m.enabled === 'boolean') s.setLoop(m.enabled);
    if (m.kind === 'select' && finite(m.index)) s.select(m.index, m.mode === 'toggle' || m.mode === 'range' ? m.mode : 'replace');
    if (m.kind === 'navigate' && finite(m.index)) await s.navigate(m.index);
    return;
  }
  switch (m.kind) {
    case 'openExport': if (optional(m.token, text) && optional(m.time, finite)) s.openExportDialog(m.token, m.time); return;
    case 'closeExport': if (text(m.id)) s.exports.close(m.id); return;
    case 'submitExport': if (text(m.id)) await s.exports.submit(m.id, m.choice); return;
    case 'cancelExport': s.exports.cancel(); return;
    case 'saveFrame': if (text(m.token)) await s.saveFrame(m.token); return;
    case 'referenceError': if (text(m.token) && text(m.message)) await s.referenceFailed(m.token, m.message); return;
    case 'referenceDisplayed': if (text(m.token)) await s.referencePresented(m.token); return;
    case 'displayed': if (text(m.token) && finite(m.request) && finite(m.sequence)) await s.presented(m.token, m.request, m.sequence); return;
    case 'mediaError': if (text(m.token) && text(m.message)) s.mediaFailed(m.token, m.message); return;
    case 'copyPoint': if (text(m.token) && finite(m.x) && finite(m.y)) await s.copyPoint(m.token, m.x, m.y); return;
    case 'playback':
      if (text(m.token) && finite(m.seekSequence) && finite(m.time) && finite(m.sequence) && optional(m.currentTime, finite)) {
        s.playback(m.token, m.seekSequence, m.time, m.currentTime, typeof m.playing === 'boolean' ? m.playing : undefined, m.sequence);
      }
      return;
  }
  if (!current) return;
  if (m.kind === 'compare' && typeof m.enabled === 'boolean' && optional(m.token, text) && optional(m.time, finite)) s.setComparison(m.enabled, m.token, m.time, m.replace === true);
  if (m.kind === 'step' && (m.direction === -1 || m.direction === 1)) s.step(m.direction);
  // A play or pause request belongs to the position and media that the user saw.
  if ((m.kind === 'play' || m.kind === 'pause') && m.request === s.seekSequence && (m.token === undefined || m.token === s.preview?.media.path)) {
    if (m.kind === 'play') s.play(); else s.pause();
  }
}
