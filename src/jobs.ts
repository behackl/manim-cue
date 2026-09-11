import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { runProcess } from './process';
import { readDiagnostic, RuntimeUnavailable } from './diagnostics';
import { renderSettings, encoderOptions, type RenderSettings } from './export-settings';
import { MAX_REPORT_BYTES, parseTimeline, type Timeline } from './timeline';

export interface Profile { version: string; module: string; fps: number; width: number; height: number; frameWidth: number; frameHeight: number; seed: number; configs: Record<string, string | null>; captureFrame?: boolean; timeline?: boolean; videoEncoder?: boolean }
export interface Media { path: string; kind: 'video' | 'image'; duration: number; rate: number; hasAudio: boolean;
  averageRate: number; frames: number; maxFrameTimeError: number; frameTimes?: number[] | null;
  capture?: { requestedTime: number; time: number | null; frameIndex: number | null } }
export interface Observation { directory: string; source: string; sourceHash: string; profile: Profile }
export interface PreviewResult extends Observation { media: Media }
export interface RunResult extends Observation { timeline: Timeline; media?: Media }
export interface JobOptions {
  source: string; scene: string; python: string; env: NodeJS.ProcessEnv; cwd: string;
  fps: number; width: number; timeout: number; preview: boolean;
  scratch: string; helpers: string; signal: AbortSignal; exportSettings?: RenderSettings;
  log: (s: string) => void; phase: (s: string) => void;
  timelineReady: (result: RunResult) => void;
}
export interface SceneJob { options: JobOptions; directory: string; sourceHash: string; cache: string; prefix: string[]; request: string; profile?: Profile }
export class InputsChanged extends Error {}
export async function fileHash(file: string): Promise<string> { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function maybeHash(file: string): Promise<string | null> {
  try { return await fileHash(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function checkInputs(result: Observation): Promise<void> {
  if (await maybeHash(result.source) !== result.sourceHash) throw new InputsChanged('Primary source changed during the run. Save and refresh.');
  for (const [file, hash] of Object.entries(result.profile.configs)) {
    if (await maybeHash(file) !== hash) throw new InputsChanged('Manim configuration changed during the run. Refresh.');
  }
}
export async function createJob(o: JobOptions): Promise<SceneJob> {
  await fs.mkdir(o.scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(o.scratch, 'run-'));
  await fs.mkdir(path.join(directory, 'media'));
  const sourceHash = await fileHash(o.source);
  const cacheKey = createHash('sha256').update(JSON.stringify([o.python, o.cwd, path.dirname(o.source),
    Object.entries(o.env).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  const cache = path.join(o.scratch, 'cache-v1', cacheKey);
  const prefix = ['-B', '--check-hash-based-pycs', 'always', '-X', `pycache_prefix=${path.join(cache, 'bytecode')}`,
    path.join(o.helpers, 'cache_runner.py')];
  const request = path.join(directory, 'request.json');
  await fs.writeFile(request, JSON.stringify({ run: directory, cache: path.join(cache, 'typesetting'), source: o.source,
    sourceHash, scene: o.scene, fps: o.fps, width: o.width,
    export: o.exportSettings ? { ...renderSettings(o.exportSettings), encoderOptions: encoderOptions(o.exportSettings.options) } : undefined }));
  return { options: o, directory, sourceHash, cache, prefix, request };
}
async function invoke(job: SceneJob, args: string[], signal: AbortSignal, label: string): Promise<void> {
  const o = job.options, start = performance.now();
  signal.throwIfAborted();
  if (await maybeHash(o.source) !== job.sourceHash) throw new InputsChanged('Primary source changed. Save and refresh.');
  if (job.profile) await checkInputs({ source: o.source, sourceHash: job.sourceHash, directory: job.directory, profile: job.profile });
  try {
    await runProcess(o.python, [...job.prefix, ...args], {
      cwd: o.cwd, env: { ...o.env, PYTHONIOENCODING: 'utf-8' }, signal, timeout: o.timeout, log: o.log,
      timeoutHint: 'Increase manimCue.timeoutSeconds if needed.',
    });
  } catch (error) {
    // Workers are serialized; clear partial typesetting output before the next job.
    await fs.rm(path.join(job.cache, 'typesetting'), { recursive: true, force: true }).catch(() => {
      o.log('\n[Cue cache] Could not clear interrupted typesetting output; use Clear Caches before retrying.\n');
    });
    if (await maybeHash(o.source) !== job.sourceHash) throw new InputsChanged('Primary source changed during the run. Save and refresh.');
    if (job.profile) await checkInputs({ source: o.source, sourceHash: job.sourceHash, directory: job.directory, profile: job.profile });
    if (!signal.aborted) {
      const diagnostic = await readDiagnostic(path.join(job.directory, 'diagnostic.json')).catch(() => undefined);
      if (diagnostic && (o.exportSettings ? !diagnostic.video_encoder : !diagnostic.timeline && !diagnostic.capture_frame)) throw new RuntimeUnavailable(diagnostic);
    }
    throw error;
  } finally { o.log(`\n[Cue timing] ${label}: ${((performance.now() - start) / 1000).toFixed(3)} s\n`); }
}
async function observation(job: SceneJob, signal: AbortSignal): Promise<Observation> {
  const file = path.join(job.directory, 'profile.json');
  if ((await fs.stat(file)).size > 65536) throw new Error('Invalid profile size.');
  const profile: Profile = JSON.parse(await fs.readFile(file, 'utf8'));
  if (![profile.frameWidth, profile.frameHeight, profile.fps, profile.width, profile.height].every(n => Number.isFinite(n) && n > 0) ||
    profile.fps !== job.options.fps || profile.width !== Math.floor(job.options.width / 2) * 2 || profile.width * profile.height > 32_000_000) {
    throw new Error('Invalid capture profile.');
  }
  if (job.profile && JSON.stringify(profile) !== JSON.stringify(job.profile)) throw new InputsChanged('Prepared profile changed. Refresh.');
  job.profile = profile;
  const result = { directory: job.directory, source: job.options.source, sourceHash: job.sourceHash, profile };
  await checkInputs(result); signal.throwIfAborted();
  return result;
}
async function checkPng(file: string, profile: Profile): Promise<void> {
  if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error('Preview image exceeds the 64 MiB limit.');
  const bytes = await fs.readFile(file);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) !== profile.width || bytes.readUInt32BE(20) !== profile.height) throw new Error('Invalid preview PNG or pixel dimensions.');
}
export async function captureFrame(job: SceneJob, time: number, signal = job.options.signal): Promise<PreviewResult | undefined> {
  if (!Number.isFinite(time) || time < 0) throw new Error('Choose a finite, nonnegative time.');
  const token = randomUUID(), request = path.join(job.directory, `capture-${token}.json`);
  const output = path.join(job.directory, 'media', `frame-${token}.json`);
  await fs.writeFile(request, JSON.stringify({ ...JSON.parse(await fs.readFile(job.request, 'utf8')), time }));
  try {
    await invoke(job, [path.join(job.options.helpers, 'support.py'), 'capture', request, output], signal, 'Current-frame capture');
    const result = await observation(job, signal);
    if ((await fs.stat(output)).size > 16384) throw new Error('Invalid capture response size.');
    const data = JSON.parse(await fs.readFile(output, 'utf8'));
    if (data.kind === 'unsupported' && result.profile.captureFrame === false) return undefined;
    if (!['frame', 'snapshot'].includes(data.kind) || data.requestedTime !== time || data.width !== result.profile.width || data.height !== result.profile.height) throw new Error('Capture does not match the request.');
    if (data.kind === 'frame') {
      if (!Number.isSafeInteger(data.frameIndex) || data.frameIndex < 0 || !Number.isFinite(data.time) ||
        Math.abs(data.time - data.frameIndex / result.profile.fps) > 1e-8 || time < data.time || time >= (data.frameIndex + 1) / result.profile.fps) throw new Error('Invalid captured frame timing.');
    } else if (data.time !== null || data.frameIndex !== null) throw new Error('An end-state snapshot must have no frame timestamp.');
    const image = output.replace(/\.json$/, '.png');
    await checkPng(image, result.profile);
    await checkInputs(result); signal.throwIfAborted();
    return { ...result, media: { path: image, kind: 'image', duration: 0, rate: result.profile.fps, hasAudio: false,
      averageRate: 0, frames: 0, maxFrameTimeError: 0, capture: { requestedTime: time, time: data.time, frameIndex: data.frameIndex } } };
  } finally { await Promise.all([request, output].map(p => fs.rm(p, { force: true }))); }
}
export async function evaluateTimeline(job: SceneJob, signal = job.options.signal): Promise<RunResult> {
  if (job.profile?.timeline === false) throw new Error('Timeline and full preview require Manager.evaluate(capture_timeline=True). Current-frame capture remains available. Run Manim Cue: Check Python Environment for details.');
  const helper = path.join(job.options.helpers, 'support.py'), report = path.join(job.directory, 'timeline.json');
  await invoke(job, [helper, 'evaluate', job.request, report], signal, 'Timeline evaluation');
  const result = await observation(job, signal);
  await invoke(job, [helper, 'verify', report, path.join(job.directory, 'verified.json')], signal, 'Timeline integrity verification');
  if ((await fs.stat(report)).size > MAX_REPORT_BYTES) throw new Error('Timeline exceeds the 16 MiB viewer limit.');
  const timeline = parseTimeline(await fs.readFile(report, 'utf8'));
  if (timeline.source.sha256 !== job.sourceHash || timeline.scene.name !== job.options.scene || timeline.backend !== 'CairoRenderer' || timeline.frame_rate !== result.profile.fps) {
    throw new Error('Timeline source, scene or evaluation profile does not match the requested run.');
  }
  await checkInputs(result); signal.throwIfAborted();
  return { ...result, timeline };
}
export async function renderPreview(job: SceneJob, result: RunResult, signal = job.options.signal): Promise<PreviewResult> {
  await checkInputs(result);
  const still = result.timeline.end === result.timeline.start;
  const output = path.join(job.directory, 'media', `preview-${randomUUID()}.${still ? 'png' : 'mp4'}`);
  await invoke(job, ['-m', 'manim', '--config_file', path.join(job.directory, 'cue.cfg'), '--silent', '--progress_bar', 'none',
    '--format', still ? 'png' : 'mp4', '-o', output, job.options.source, job.options.scene], signal, 'Preview render');
  let media: Media;
  if (still) {
    await checkPng(output, result.profile);
    media = { path: output, kind: 'image', duration: 0, rate: 0, hasAudio: false, averageRate: 0, frames: 0, maxFrameTimeError: 0 };
  } else {
    const metadata = path.join(job.directory, 'video.json');
    await invoke(job, [path.join(job.options.helpers, 'support.py'), 'probe', output, metadata], signal, 'Video verification');
    if ((await fs.stat(metadata)).size > MAX_REPORT_BYTES) throw new Error('Video timing metadata exceeds the viewer limit.');
    const data = JSON.parse(await fs.readFile(metadata, 'utf8'));
    if (![data.rate, data.duration, data.frames].every(n => Number.isFinite(n) && n > 0) || !Number.isSafeInteger(data.frames) || data.width !== result.profile.width || data.height !== result.profile.height) throw new Error('Invalid video profile.');
    if (data.frameTimes !== null && (!Array.isArray(data.frameTimes) || data.frameTimes.length !== data.frames || data.frameTimes.length > 500_000 ||
      data.frameTimes.some((t: number, i: number, a: number[]) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= a[i - 1])))) throw new Error('Invalid video frame timestamps.');
    media = { ...data, path: output, kind: 'video' };
    job.options.log(`\n[Cue video] ${media.rate} fps nominal, ${media.averageRate} fps average; ${media.frames} frames; maximum PTS deviation ${media.maxFrameTimeError.toFixed(6)} s\n`);
  }
  await checkInputs(result); signal.throwIfAborted();
  return { ...result, media };
}
/** Independent production render: no timeline evaluation or preview pairing/publication. */
export async function renderExport(job: SceneJob, signal: AbortSignal): Promise<PreviewResult> {
  const settings = renderSettings(job.options.exportSettings);
  const helper = path.join(job.options.helpers, 'support.py');
  await invoke(job, [helper, 'prepare', job.request, path.join(job.directory, 'profile.json')], signal, 'Export profile');
  const result = await observation(job, signal);
  const output = path.join(job.directory, 'media', `export-${randomUUID()}.mp4`);
  await invoke(job, ['-m', 'manim', '--config_file', path.join(job.directory, 'cue.cfg'), '--silent', '--progress_bar', 'none',
    '--format', 'mp4', '-o', output, job.options.source, job.options.scene], signal, 'Full Scene export');
  if (!await fs.stat(output).then(s => s.size > 0, (e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return false; })) {
    throw new Error('Scene produced no video. Save the current frame as PNG instead.');
  }
  const metadata = path.join(job.directory, 'export-video.json');
  await invoke(job, [helper, 'probe-export', output, metadata], signal, 'Export verification');
  if ((await fs.stat(metadata)).size > 16384) throw new Error('Invalid export metadata size.');
  const data = JSON.parse(await fs.readFile(metadata, 'utf8'));
  if (data.width !== settings.width || data.height !== settings.height || !Number.isFinite(data.rate) || Math.abs(data.rate - settings.fps) > .0001 ||
    !Number.isSafeInteger(data.frames) || data.frames < 1 || !Number.isFinite(data.duration) || data.duration <= 0 || data.codec !== 'h264' || data.pixelFormat !== 'yuv420p') {
    throw new Error('Rendered video does not match the requested dimensions, FPS or H.264/yuv420p profile.');
  }
  await checkInputs(result); signal.throwIfAborted();
  return { ...result, media: { ...data, path: output, kind: 'video' } };
}
// Only completed media enters this stable webview root; profiles, source and caches stay private.
export async function publishPreview(result: PreviewResult, root: string): Promise<PreviewResult> {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, path.basename(result.media.path));
  await fs.copyFile(result.media.path, file, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  return { ...result, media: { ...result.media, path: file } };
}
// Timeline-only/full-render entry point, also used by integration consumers.
export async function executeJob(o: JobOptions): Promise<RunResult> {
  const job = await createJob(o);
  o.phase('Checking environment and evaluating scene…');
  const result = await evaluateTimeline(job);
  o.timelineReady(result);
  if (!o.preview) return result;
  o.phase('Rendering preview…');
  return { ...result, media: (await renderPreview(job, result)).media };
}
