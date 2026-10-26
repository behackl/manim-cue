import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { ProcessFailed, runProcess } from './process';
import { readDiagnostic, RuntimeUnavailable } from './diagnostics';
import { renderSettings, encoderOptions, type RenderSettings } from './export-settings';
import { parseTimeline, type Timeline } from './timeline';
import { skippedParts } from './video-time';
import type { TimeRange } from './selection';

export interface Profile { version: string; module: string; fps: number; width: number; height: number; frameWidth: number; frameHeight: number; seed: number; configs: Record<string, string | null>; videoEncoder: boolean }
/** For a video, `duration` is in scene time and `skipped` lists the scene-time parts that it leaves out. */
export interface Media { path: string; kind: 'video' | 'image'; duration: number; rate: number; hasAudio: boolean;
  capture?: { requestedTime: number; time: number | null }; skipped?: TimeRange[] }
/** `outdated`: the source or the settings changed after the result started. */
export interface Result { directory: string; source: string; sourceHash: string; profile: Profile; outdated: boolean }
export interface PreviewResult extends Result { media: Media }
export interface TimelineResult extends Result { timeline: Timeline; file: string }
export interface JobOptions {
  source: string; scene: string; python: string; env: NodeJS.ProcessEnv; cwd: string;
  fps: number; width: number; timeout: number;
  scratch: string; helpers: string; signal: AbortSignal; exportSettings?: RenderSettings;
  log: (s: string) => void;
}
/** One saved source and one set of settings. Its results share one run directory. */
export interface SceneJob { options: JobOptions; directory: string; sourceHash: string; cache: string; request: Record<string, unknown> }

export async function fileHash(file: string): Promise<string> { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
export async function createJob(o: JobOptions): Promise<SceneJob> {
  await fs.mkdir(o.scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(o.scratch, 'run-'));
  await fs.mkdir(path.join(directory, 'media'));
  const sourceHash = await fileHash(o.source);
  const cacheKey = createHash('sha256').update(JSON.stringify([o.python, o.cwd, path.dirname(o.source),
    Object.entries(o.env).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  const cache = path.join(o.scratch, 'cache-v1', cacheKey);
  const request = { run: directory, cache: path.join(cache, 'typesetting'), source: o.source,
    sourceHash, scene: o.scene, fps: o.fps, width: o.width,
    export: o.exportSettings ? { ...renderSettings(o.exportSettings), encoderOptions: encoderOptions(o.exportSettings.options) } : undefined };
  return { options: o, directory, sourceHash, cache, request };
}
async function run(job: SceneJob, command: 'inspect' | 'render', fields: Record<string, unknown>, signal: AbortSignal, line?: (text: string) => void): Promise<void> {
  const o = job.options, start = performance.now();
  const request = path.join(job.directory, `${command}-${randomUUID()}.json`);
  await fs.writeFile(request, JSON.stringify({ ...job.request, ...fields }));
  try {
    await runProcess(o.python, ['-B', '--check-hash-based-pycs', 'always', '-X', `pycache_prefix=${path.join(job.cache, 'bytecode')}`,
      path.join(o.helpers, 'cache_runner.py'), path.join(o.helpers, 'support.py'), command, request], {
      cwd: o.cwd, env: { ...o.env, PYTHONIOENCODING: 'utf-8' }, signal, timeout: o.timeout, log: o.log, line,
      timeoutHint: 'Increase “Manim Cue: Timeout Seconds” to wait longer.',
    });
  } catch (error) {
    // Workers are serialized; clear partial typesetting output before the next job.
    await fs.rm(path.join(job.cache, 'typesetting'), { recursive: true, force: true }).catch(() => {
      o.log('\n[Cue cache] Could not clear interrupted typesetting output; use Clear Caches before retrying.\n');
    });
    if (!signal.aborted) {
      const diagnostic = await readDiagnostic(path.join(job.directory, 'diagnostic.json')).catch(() => undefined);
      if (diagnostic && (o.exportSettings ? !diagnostic.video_encoder : !diagnostic.timeline || !diagnostic.capture_frame)) throw new RuntimeUnavailable(diagnostic);
    }
    if (error instanceof ProcessFailed) throw new Error(errorLine(error.detail));
    throw error;
  } finally {
    await fs.rm(request, { force: true });
    o.log(`\n[Cue timing] ${command === 'inspect' ? 'Scene inspection' : 'Scene render'}: ${((performance.now() - start) / 1000).toFixed(3)} s\n`);
  }
}
/**
 * The error for the UI; the log has the complete output. A traceback ends with the
 * exception line, which a terminal-width console can wrap over more lines.
 */
export function errorLine(output: string): string {
  const lines = output.trim().split('\n').map(line => line.trim()).filter(Boolean);
  let start = lines.length - 1;
  while (start >= 0 && !/^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/u.test(lines[start])) start--;
  const line = start < 0 ? lines.at(-1) : lines.slice(start).join(' ');
  // Long run and cache paths only hide the message: keep their file names.
  return line?.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'"(),:\\/]+[\\/])+(?=[^\s'"(),:\\/])/gu, '').slice(0, 500) || 'Python stopped with an error. See the log.';
}
async function newResult(job: SceneJob): Promise<Result> {
  const profile: Profile = JSON.parse(await fs.readFile(path.join(job.directory, 'profile.json'), 'utf8'));
  return { directory: job.directory, source: job.options.source, sourceHash: job.sourceHash, profile, outdated: false };
}
export interface Inspection { frame?: PreviewResult; timeline?: TimelineResult }
/**
 * Evaluates the scene once. With a time, `frame` receives the frame as soon as Python
 * reports it; without a timeline, the process ends after the frame.
 */
export async function inspect(job: SceneJob, request: { time?: number; timeline: boolean }, signal: AbortSignal,
  frame: (result: PreviewResult) => Promise<void> | void = () => {}): Promise<Inspection> {
  const token = randomUUID(), image = path.join(job.directory, 'media', `frame-${token}.png`);
  const file = request.timeline ? path.join(job.directory, `timeline-${token}.json`) : undefined;
  const result: Inspection = {};
  let published: Promise<void> = Promise.resolve();
  await run(job, 'inspect', { time: request.time, frame: image, timeline: file }, signal, line => {
    if (!line.startsWith('[Cue frame] ')) return;
    const capture = JSON.parse(line.slice(12));
    published = newResult(job).then(o => {
      result.frame = { ...o, media: { path: image, kind: 'image', duration: 0, rate: o.profile.fps, hasAudio: false, capture } };
      return frame(result.frame);
    });
    published.catch(() => {}); // A failed run is the error to report; the await below reports this one.
  });
  await published;
  if (file) result.timeline = { ...await newResult(job), timeline: parseTimeline(await fs.readFile(file, 'utf8')), file };
  return result;
}
/** Renders the preview video and the timeline of the same run. */
export async function renderPreview(job: SceneJob, signal: AbortSignal): Promise<{ video: PreviewResult; timeline: TimelineResult }> {
  const token = randomUUID(), output = path.join(job.directory, 'media', `preview-${token}.mp4`), file = path.join(job.directory, `timeline-${token}.json`);
  await run(job, 'render', { output, timeline: file }, signal);
  const o = await newResult(job), t = parseTimeline(await fs.readFile(file, 'utf8'));
  return { timeline: { ...o, timeline: t, file }, video: { ...o, media: { path: output, kind: 'video', duration: t.duration, rate: t.frame_rate,
    hasAudio: t.entries.some(e => e.kind === 'sound'), skipped: skippedParts(t.entries) } } };
}
/** Independent production render: no timeline and no preview publication. */
export async function renderExport(job: SceneJob, signal: AbortSignal): Promise<Result & { file: string }> {
  const output = path.join(job.directory, 'media', `export-${randomUUID()}.mp4`);
  await run(job, 'render', { output }, signal);
  if (!await fs.stat(output).then(s => s.size > 0, () => false)) throw new Error('The scene has no video. Save its frame as PNG.');
  return { ...await newResult(job), file: output };
}
// Only completed media enters this stable webview root; profiles, source and caches stay private.
export async function publishPreview(result: PreviewResult, root: string): Promise<PreviewResult> {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, path.basename(result.media.path));
  await fs.copyFile(result.media.path, file, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  return { ...result, media: { ...result.media, path: file } };
}
