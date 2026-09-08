import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runProcess } from './process';
import { MAX_REPORT_BYTES, parseTimeline, type Timeline } from './timeline';

export interface Profile { version: string; module: string; fps: number; width: number; height: number; frameWidth: number; frameHeight: number; seed: number; configs: Record<string, string | null> }
export interface Media { path: string; kind: 'video' | 'image'; duration: number; rate: number; hasAudio: boolean;
  averageRate: number; frames: number; maxFrameTimeError: number }
export interface RunResult { timeline: Timeline; directory: string; source: string; sourceHash: string; profile: Profile; media?: Media }
export interface JobOptions {
  source: string; scene: string; python: string; env: NodeJS.ProcessEnv; cwd: string;
  fps: number; width: number; timeout: number; preview: boolean;
  scratch: string; helpers: string; signal: AbortSignal;
  log: (s: string) => void; phase: (s: string) => void;
  timelineReady: (result: RunResult) => void;
}
export async function fileHash(file: string): Promise<string> { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
async function maybeHash(file: string): Promise<string | null> {
  try { return await fileHash(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function checkInputs(result: RunResult): Promise<void> {
  if (await maybeHash(result.source) !== result.sourceHash) throw new Error('Primary source changed during the run. Save and refresh.');
  for (const [file, hash] of Object.entries(result.profile.configs)) {
    if (await maybeHash(file) !== hash) throw new Error('Manim configuration changed during the run. Refresh.');
  }
}
export async function executeJob(o: JobOptions): Promise<RunResult> {
  const started = performance.now();
  const timed = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await action(); }
    finally { o.log(`\n[Cue timing] ${label}: ${((performance.now() - start) / 1000).toFixed(3)} s\n`); }
  };
  await fs.mkdir(o.scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(o.scratch, 'run-'));
  await fs.mkdir(path.join(directory, 'media'));
  const sourceHash = await fileHash(o.source);
  const cacheKey = createHash('sha256').update(JSON.stringify([o.python, o.cwd, path.dirname(o.source),
    Object.entries(o.env).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  const cache = path.join(o.scratch, 'cache-v1', cacheKey);
  const prefix = ['-B', '--check-hash-based-pycs', 'always', '-X', `pycache_prefix=${path.join(cache, 'bytecode')}`,
    path.join(o.helpers, 'cache_runner.py')];
  const invoke = async (args: string[]) => {
    try {
      return await runProcess(o.python, [...prefix, ...args], {
        cwd: o.cwd, env: { ...o.env, PYTHONIOENCODING: 'utf-8' }, signal: o.signal, timeout: o.timeout, log: o.log,
      });
    } catch (error) {
      // Typesetters can leave a partial SVG when interrupted. Do not reuse it on
      // the next refresh. Checked-hash bytecode is atomic and remains reusable.
      await fs.rm(path.join(cache, 'typesetting'), { recursive: true, force: true }).catch(() => {
        o.log('\n[Cue cache] Could not clear interrupted typesetting output; use Clear Caches before retrying.\n');
      });
      throw error;
    }
  };
  const helper = path.join(o.helpers, 'support.py');
  const request = path.join(directory, 'request.json'), profileFile = path.join(directory, 'profile.json');
  await fs.writeFile(request, JSON.stringify({ run: directory, cache: path.join(cache, 'typesetting'), source: o.source, scene: o.scene, fps: o.fps, width: o.width }));
  const report = path.join(directory, 'timeline.json');
  o.phase('Checking environment and evaluating scene — no raster or video…');
  await timed('Profile preparation + no-raster evaluation', () => invoke([helper, 'evaluate', request, report]));
  const profile: Profile = JSON.parse(await fs.readFile(profileFile, 'utf8'));
  if (![profile.frameWidth, profile.frameHeight].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid configured scene dimensions.');
  const base = ['-m', 'manim', '--config_file', path.join(directory, 'cue.cfg'), '--silent', '--progress_bar', 'none'];
  await timed('Timeline integrity verification', () => invoke([helper, 'verify', report, path.join(directory, 'verified.json')]));
  if ((await fs.stat(report)).size > MAX_REPORT_BYTES) throw new Error('Timeline exceeds the 16 MiB viewer limit.');
  const timeline = parseTimeline(await fs.readFile(report, 'utf8'));
  if (timeline.source.sha256 !== sourceHash || timeline.scene.name !== o.scene || timeline.backend !== 'CairoRenderer' || timeline.frame_rate !== o.fps) {
    throw new Error('Timeline source, scene or evaluation profile does not match the requested run.');
  }
  const result: RunResult = { timeline, directory, source: o.source, sourceHash, profile };
  await checkInputs(result);
  o.signal.throwIfAborted();
  o.log(`\n[Cue timing] Timeline available: ${((performance.now() - started) / 1000).toFixed(3)} s\n`);
  o.timelineReady(result);
  if (!o.preview) return result;
  const still = timeline.events.length === 0 || timeline.end === timeline.start;
  const output = path.join(directory, 'media', still ? 'preview.png' : 'preview.mp4');
  o.phase(still ? 'Rendering separate still preview…' : 'Rendering separate, uncached preview…');
  await timed('Preview render', () => invoke([...base, '--format', still ? 'png' : 'mp4', '-o', output, o.source, o.scene]));
  let media: Media;
  if (still) {
    const bytes = await fs.readFile(output);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Expected a completed PNG preview.');
    media = { path: output, kind: 'image', duration: 0, rate: 0, hasAudio: false, averageRate: 0, frames: 0, maxFrameTimeError: 0 };
  } else {
    o.phase('Verifying finalized video…');
    const meta = path.join(directory, 'video.json');
    await timed('Video verification', () => invoke([helper, 'probe', output, meta]));
    media = { ...JSON.parse(await fs.readFile(meta, 'utf8')), path: output, kind: 'video' };
    o.log(`\n[Cue video] ${media.rate} fps nominal, ${media.averageRate} fps average; ${media.frames} decoded frames; maximum timestamp deviation ${media.maxFrameTimeError.toFixed(6)} s; duration ${media.duration.toFixed(6)} s\n`);
  }
  await checkInputs(result);
  o.signal.throwIfAborted();
  return { ...result, media };
}
