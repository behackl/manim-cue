import * as vscode from 'vscode';
import type { FrameMedia, Model } from './protocol';
import type { PreviewResult } from './jobs';
import type { Session } from './session';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const text = (x: unknown): x is string => typeof x === 'string';
const range = (x: unknown) => {
  const r = x as { start?: unknown; end?: unknown } | undefined;
  return r && finite(r.start) && finite(r.end) ? { start: r.start, end: r.end } : undefined;
};

/** The state that both webviews show. */
export function model(s: Session, webview?: vscode.Webview): Model {
  const media = (r: PreviewResult) => ({ id: r.media.path, uri: webview ? webview.asWebviewUri(vscode.Uri.file(r.media.path)).toString() : '',
    outdated: r.outdated, frame: { width: r.profile.frameWidth, height: r.profile.frameHeight } });
  const frame = (r?: PreviewResult): FrameMedia | undefined => r && { ...media(r), requestedTime: r.media.capture!.requestedTime, time: r.media.capture!.time };
  const profile = s.timeline?.profile, video = s.video?.media;
  return {
    scene: s.target?.scene ?? '', status: s.exports.nativeBusy ? 'Rendering for export…' : s.status, busy: s.busy, error: s.error,
    autoPreview: s.autoPreview, fps: s.job?.options.fps ?? vscode.workspace.getConfiguration('manimCue', s.target?.uri).get<number>('frameRate', 30),
    profile: profile && `${profile.fps} fps · ${profile.width} × ${profile.height}`,
    job: s.job?.directory, time: s.time,
    timeline: s.timeline?.timeline, timelineKey: s.timeline?.directory, timelineOutdated: !!s.timeline?.outdated,
    frame: frame(s.frame), reference: frame(s.reference),
    video: video && { ...media(s.video!), duration: video.duration, rate: video.rate, skipped: video.skipped ?? [] },
    loop: s.loop, exportState: s.exports.snapshot(webview),
  };
}

/** Checks a message from a webview and passes it to the session. */
export async function receive(s: Session, data: unknown, origin: 'timeline' | 'preview'): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const m = data as Record<string, unknown>;
  switch (m.kind) {
    case 'ready': s.views.update(); return;
    case 'refresh': await s.refresh(); return;
    case 'cancel': s.cancel(); return;
    case 'preview': await s.renderVideo(); return;
    case 'export': await s.exports.saveTimeline(); return;
    case 'logs': await vscode.commands.executeCommand('manimCue.logs'); return;
    case 'doctor': await vscode.commands.executeCommand('manimCue.doctor'); return;
    case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${s.extensionId}`); return;
  }
  if (origin === 'timeline') {
    if (m.kind === 'seek' && finite(m.time) && m.time >= 0) s.seek(m.time);
    if (m.kind === 'loop') s.setLoop(range(m.range));
    if (m.kind === 'navigate' && finite(m.index)) await s.navigate(m.index);
    return;
  }
  switch (m.kind) {
    case 'position': if (finite(m.time) && m.time >= 0) s.position(m.time); return;
    case 'frameNeeded': if (finite(m.time) && m.time >= 0) s.requestFrame(m.time); return;
    case 'pin': if (text(m.id)) s.pin(m.id); return;
    case 'copyPoint': if (finite(m.x) && finite(m.y)) await s.copyPoint(m.x, m.y); return;
    case 'openExport': if (finite(m.time) && m.time >= 0) s.exports.open(m.time, m.video === true); return;
    case 'closeExport': if (text(m.id)) s.exports.close(m.id); return;
    case 'submitExport': if (text(m.id)) await s.exports.submit(m.id, m.choice); return;
    case 'cancelExport': s.exports.cancel(); return;
  }
}
