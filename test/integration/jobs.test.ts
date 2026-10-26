import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJob, inspect, publishPreview, renderExport, renderPreview, type JobOptions } from '../../src/jobs';
import { isCall } from '../../src/timeline';
import { runProcess } from '../../src/process';
import { checkPython, RuntimeUnavailable } from '../../src/diagnostics';
const python = process.env.MANIM_PYTHON;
if (!python) throw new Error('Set MANIM_PYTHON to the executable of a supported Manim environment; integration tests are not silently skipped.');
const signal = new AbortController().signal;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const options = (source: string, scratch: string): JobOptions => ({
  python: python!, source, scene: 'Demo', cwd: path.dirname(source), fps: 4, width: 128,
  timeout: 60000, env: process.env, helpers: path.resolve('python'), scratch, signal, log: () => {},
});
const evaluate = async (o: JobOptions) => (await inspect(await createJob(o), { timeline: true }, signal)).timeline!;
const render = async (o: JobOptions) => renderPreview(await createJob(o), signal);
const calls = (t: { entries: import('../../src/timeline').Entry[] }) => t.entries.filter(isCall).map(e => [e.start, e.end, e.frozen]);
/** Frame count, rate and largest timestamp deviation from i / rate, read with PyAV. */
async function probe(file: string): Promise<{ frames: number; rate: number; drift: number; audio: boolean }> {
  const output = await runProcess(python!, ['-c', `import av, json, sys
with av.open(sys.argv[1]) as c:
    s = c.streams.video[0]; rate = float(s.guessed_rate)
    times = sorted(float(f.pts * f.time_base) for f in c.decode(s))
    print(json.dumps({"frames": len(times), "rate": rate, "drift": max(abs(t - i / rate) for i, t in enumerate(times)), "audio": bool(c.streams.audio)}))`, file], { cwd: os.tmpdir(), timeout: 30000, signal });
  return JSON.parse(output);
}

test('independent export renders requested dimensions/FPS/audio and replaces inherited encoder options without a timeline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-export-native-'));
  try {
    const source = path.join(root, 'scene.py');
    await fs.copyFile('examples/cue.wav', path.join(root, 'cue.wav'));
    await fs.writeFile(source, 'from manim import Scene, Square, config\nclass Demo(Scene):\n    def construct(self):\n        assert config.frame_rate == 12\n        self.add(Square())\n        self.add_sound("cue.wav")\n        self.wait(1)\n');
    await fs.writeFile(path.join(root, 'manim.cfg'), '[CLI]\npixel_width=640\npixel_height=480\nframe_rate=4\npreview=True\nformat=png\nseed=42\n[video_encoder]\ncodec=libvpx-vp9\n[video_encoder.options]\ncrf=40\ndeadline=realtime\n');
    const settings = { width: 320, height: 192, fps: 12, crf: 18, preset: 'medium' as const, options: 'threads=1' };
    const job = await createJob({ ...options(source, path.join(root, 'runs')), width: settings.width, fps: settings.fps, exportSettings: settings });
    const result = await renderExport(job, signal);
    assert.equal(result.profile.width, 320); assert.equal(result.profile.height, 192); assert.equal(result.profile.seed, 42);
    assert.deepEqual(await probe(result.file), { frames: 12, rate: 12, drift: 0, audio: true });
    assert.deepEqual((await fs.readdir(job.directory)).filter(f => f.startsWith('timeline')), []);
    const cfg = await fs.readFile(path.join(job.directory, 'cue.cfg'), 'utf8');
    assert.match(cfg, /crf = 18/); assert.match(cfg, /preset = medium/); assert.match(cfg, /threads = 1/); assert.doesNotMatch(cfg, /deadline/);
    assert.match(await fs.readFile(path.join(root, 'manim.cfg'), 'utf8'), /codec=libvpx-vp9/, 'project config is untouched');
    const broken = await createJob({ ...job.options, exportSettings: { ...settings, options: 'profile=not-a-profile' } });
    await assert.rejects(renderExport(broken, signal), (error: Error) => {
      assert.match(error.message, /^\S.*$/, 'one line from the error output; the log has the rest');
      console.log('Encoder failure shown as:', error.message);
      return true;
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('evaluation and render give the same timeline; the video follows it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-integration-'));
  try {
    const o = { ...options(path.resolve('examples/cue_demo.py'), root), scene: 'CueDemo' };
    const evaluated = await evaluate(o);
    assert.equal(evaluated.timeline.mode, 'evaluate');
    assert.deepEqual(calls(evaluated.timeline), [[0, 1, false], [1, 1.5, false], [1.5, 2, false], [2, 2.5, false], [2.5, 2.75, true], [2.75, 3.5, false]]);
    const cue = evaluated.timeline.entries.find(e => e.kind === 'sound');
    assert.equal(cue?.start, 1.75);
    assert.ok(cue?.kind === 'sound' && cue.duration! > 0, 'sound duration comes from the file headers');
    const { video, timeline } = await render(o);
    assert.equal(timeline.timeline.mode, 'render');
    assert.deepEqual(timeline.timeline.entries, evaluated.timeline.entries);
    assert.equal(video.media.duration, 3.5); assert.equal(video.media.rate, 4); assert.equal(video.media.hasAudio, true);
    const movie = await probe(video.media.path);
    assert.equal(movie.frames, 14); assert.equal(movie.rate, 4); assert.equal(movie.audio, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('at 30 fps, the timeline gives the frame count and timestamps within half a frame', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-fractional-'));
  try {
    const source = path.join(root, 'scene.py');
    await fs.writeFile(source, `from manim import Scene, Square, RIGHT
class Demo(Scene):
    def construct(self):
        square = Square()
        self.add(square)
        for duration in (.95, .35, 1.15):
            self.play(square.animate.shift(RIGHT * .1), run_time=duration)
            self.wait(.65)
`);
    const { video, timeline } = await render({ ...options(source, path.join(root, 'runs')), fps: 30 });
    assert.equal(timeline.timeline.entries.filter(e => isCall(e) && e.frozen).length, 3);
    const movie = await probe(video.media.path);
    assert.equal(movie.frames, Math.round(video.media.duration * 30));
    assert.equal(movie.rate, 30);
    assert.ok(movie.drift < .25 / 30, `timestamp drift ${movie.drift}`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a skipped section takes no video time', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-skipped-'));
  try {
    const source = path.join(root, 'scene.py');
    await fs.writeFile(source, 'from manim import Scene\nclass Demo(Scene):\n    def construct(self):\n        self.wait(.5, frozen_frame=False)\n        self.next_section(skip_animations=True)\n        self.wait(1)\n        self.next_section()\n        self.wait(1, frozen_frame=False)\n');
    const { video, timeline } = await render(options(source, path.join(root, 'runs')));
    assert.deepEqual(timeline.timeline.entries.filter(isCall).map(e => e.skipped), [false, true, false]);
    assert.equal(video.media.duration, 2.5, 'scene time');
    assert.deepEqual(video.media.skipped, [{ start: .5, end: 1.5 }]);
    assert.equal((await probe(video.media.path)).frames, 6, 'the video has 1.5 s');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('controlled profile redirects output, disables inherited preview/skip and avoids stale primary bytecode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-config-'));
  const source = path.join(root, 'scene.py');
  try {
    const code = 'from manim import Scene\nclass Demo(Scene):\n    def construct(self): self.wait(1, frozen_frame=False)\n';
    await fs.writeFile(source, code); const stat = await fs.stat(source);
    await runProcess(python!, ['-c', 'import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)', source], { cwd: root, timeout: 5000, signal });
    await fs.writeFile(source, code.replace('wait(1', 'wait(2')); await fs.utimes(source, stat.atime, stat.mtime);
    const outside = path.join(root, 'must-not-write');
    await fs.writeFile(path.join(root, 'manim.cfg'), `[CLI]\nformat=png\ndry_run=True\npreview=True\nlive_preview=True\nwrite_all=True\nfrom_animation_number=3\nvideo_dir=${outside}\npartial_movie_dir=${outside}\noutput_file=${outside}/bad\nseed=19\nframe_width=12\nframe_height=6\n`);
    const t = await evaluate(options(source, path.join(root, 'runs')));
    const { video } = await render(options(source, path.join(root, 'runs')));
    assert.equal(t.timeline.duration, 2); assert.equal(video.media.duration, 2); assert.equal(t.profile.seed, 19);
    assert.equal(t.profile.frameWidth, 12); assert.equal(t.profile.frameHeight, 6.75, 'Cairo derives the reference height from frame width and pixel aspect');
    await assert.rejects(fs.stat(outside), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('warm caches reuse typesetting but reload same-size/same-mtime primary and helper edits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-warm-cache-'));
  const source = path.join(root, 'scene.py'), helper = path.join(root, 'duration_helper.py');
  const collect = async (dir: string, suffix: string): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await collect(file, suffix));
      else if (entry.name.endsWith(suffix)) files.push(file);
    }
    return files;
  };
  try {
    const code = 'from manim import Scene, Text\nfrom duration_helper import duration\nfrom pathlib import Path\nimport manimpango\nif Path("layout-warm").exists():\n    def uncached(*args, **kwargs): raise RuntimeError("unexpected layout cache miss")\n    manimpango.text2svg = uncached\nclass Demo(Scene):\n    def construct(self):\n        self.add(Text("cached layout"))\n        self.wait(duration * 1, frozen_frame=False)\n';
    await fs.writeFile(source, code); await fs.writeFile(helper, 'duration = 1\n');
    const o = options(source, path.join(root, 'runs'));
    assert.equal((await evaluate(o)).timeline.duration, 1);
    const cache = path.join(root, 'runs', 'cache-v1');
    const svg = (await collect(cache, '.svg'))[0]; assert.ok(svg, 'typesetting produced a cache entry');
    await fs.writeFile(path.join(root, 'layout-warm'), '');
    const pyc = (await collect(cache, '.pyc')).find(p => p.includes('duration_helper.'))!;
    assert.equal((await fs.readFile(pyc)).readUInt32LE(4), 3, 'checked-hash pyc, not a timestamp cache');
    for (const [file, text] of [[source, code.replace('* 1', '* 2')], [helper, 'duration = 2\n']]) {
      const stat = await fs.stat(file); await fs.writeFile(file, text); await fs.utimes(file, stat.atime, stat.mtime);
    }
    const { video, timeline } = await render(o);
    assert.equal(timeline.timeline.duration, 4); assert.equal(video.media.duration, 4);
    assert.ok(await fs.stat(svg), 'cached layout is reused (the real layout function would raise)');
    const header = (await fs.readFile(pyc)).subarray(0, 16);
    await fs.writeFile(pyc, header); // Valid hash header, broken marshal payload.
    assert.equal((await evaluate(o)).timeline.duration, 4, 'a corrupt cache falls back to fresh source');
    await fs.rm(path.join(root, 'layout-warm'));
    await fs.writeFile(path.join(root, 'manim.cfg'), '[CLI]\nseed=17\n');
    assert.equal((await evaluate(o)).profile.seed, 17);
    assert.ok((await collect(cache, '.svg')).length > 1, 'changed config gets a new asset cache namespace');
    await pause(1100); // The files of the failed run are the files that change during it.
    await fs.writeFile(source, code.replace('self.wait(duration * 1, frozen_frame=False)', 'self.add(Text("only in a failed run")); raise RuntimeError("failed after a new layout")'));
    const started = Date.now();
    await assert.rejects(evaluate(o), /failed after a new layout/);
    // Manim rewrites a text layout each time it uses it, so the failed run removes the layouts that it used, too.
    assert.ok(await fs.stat(svg), 'a failed run keeps the layouts of other runs');
    for (const file of await collect(cache, '.svg')) assert.ok((await fs.stat(file)).mtimeMs < started - 1000, 'a failed run removes its own layouts');
    assert.ok((await collect(cache, '.pyc')).length > 0, 'atomic checked bytecode remains reusable');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('doctor reports the actual runtime in another folder without executing scene code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-doctor-test-'));
  try {
    await fs.writeFile(path.join(root, 'scene.py'), 'raise RuntimeError("scene must not execute")\n');
    const report = await checkPython({ python: python!, env: process.env, cwd: root,
      helpers: path.resolve('python'), signal, log: () => {} });
    assert.equal(report.status, 'ready', JSON.stringify(report));
    assert.equal(await fs.realpath(report.python), await fs.realpath(python!));
    assert.equal(await fs.realpath(report.cwd), await fs.realpath(root));
    assert.ok(report.manim_module?.endsWith('__init__.py'));
    // -S provides a clean stdlib-only import path, independent of installed packages.
    const output = path.join(root, 'without-site.json');
    await runProcess(python!, ['-I', '-S', path.resolve('python/support.py'), 'diagnose', output], { cwd: root, timeout: 10000, signal });
    const missing = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(missing.status, 'missing-manim');
    assert.ok(missing.python); assert.match(missing.error, /No module named 'manim'/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an incompatible 0.21.0 build fails with a capability diagnostic before executing the Scene', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-unsupported-'));
  try {
    const source = path.join(root, 'scene.py'), marker = path.join(root, 'executed.txt');
    await fs.writeFile(source, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\n`);
    await fs.writeFile(path.join(root, 'manim.py'), '__version__ = "0.21.0"\n');
    const job = await createJob({ ...options(source, path.join(root, 'runs')), env: { ...process.env, PYTHONPATH: root } });
    await assert.rejects(inspect(job, { time: 0, timeline: false }, signal), (error: unknown) => {
      assert.ok(error instanceof RuntimeUnavailable);
      assert.equal(error.diagnostic.status, 'unsupported-manim');
      assert.equal(error.diagnostic.manim_version, '0.21.0');
      assert.match(error.diagnostic.error ?? '', /capture_timeline/);
      assert.match(error.message, /Set Up Python Environment/);
      return true;
    });
    await assert.rejects(fs.stat(marker), /ENOENT/);
    await assert.rejects(fs.stat(path.join(job.directory, 'profile.json')), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the frame arrives before the evaluation ends; without a timeline, the process stops after it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-capture-'));
  try {
    const source = path.join(root, 'scene.py');
    await fs.writeFile(source, 'from manim import Scene, Square, RIGHT\nclass Demo(Scene):\n    def construct(self):\n        s = Square()\n        self.add(s)\n        self.play(s.animate.shift(RIGHT))\n        self.wait(1, frozen_frame=False)\n        raise RuntimeError("after the frame")\n');
    const job = await createJob(options(source, path.join(root, 'runs')));
    const { frame, timeline } = await inspect(job, { time: .3, timeline: false }, signal);
    assert.equal(timeline, undefined);
    assert.equal(frame?.media.kind, 'image');
    assert.deepEqual(frame?.media.capture, { requestedTime: .3, time: .25 });
    const early: string[] = [];
    await assert.rejects(inspect(job, { time: .3, timeline: true }, signal, async f => {
      early.push(...(await fs.readdir(job.directory)).filter(n => n.startsWith('timeline')), f.media.path);
    }), /after the frame/);
    assert.equal(early.length, 1, 'frame published before the evaluation failed, without a timeline file');
    await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('        raise RuntimeError("after the frame")\n', ''));
    const fixed = await createJob(options(source, path.join(root, 'runs')));
    const miss = await inspect(fixed, { time: 10, timeline: true }, signal);
    assert.deepEqual(miss.frame?.media.capture, { requestedTime: 10, time: null }, 'the end state after the last frame');
    assert.equal(miss.timeline?.timeline.duration, 2);
    const stat = await fs.stat(source);
    await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('RIGHT))', 'RIGHT), run_time=2)'));
    await fs.utimes(source, stat.atime, stat.mtime);
    await assert.rejects(inspect(fixed, { time: .3, timeline: false }, signal), /scene file changed/);
    const updated = await inspect(await createJob(options(source, path.join(root, 'runs'))), { time: 1.25, timeline: false }, signal);
    assert.equal(updated.frame?.media.capture?.time, 1.25);
    const mediaRoot = path.join(root, 'preview-media');
    const published = await publishPreview(frame!, mediaRoot);
    const bytes = await fs.readFile(frame!.media.path);
    await fs.writeFile(frame!.media.path, 'obsolete worker output');
    await fs.rm(job.directory, { recursive: true });
    assert.deepEqual(await fs.readFile(published.media.path), bytes, 'published pixels outlive worker output');
    assert.deepEqual(await fs.readdir(mediaRoot), [path.basename(published.media.path)], 'only media is exposed to the webview');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('zero-time scene gets an end-state frame and an empty timeline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-still-'));
  try {
    const job = await createJob({ ...options(path.resolve('examples/cue_demo.py'), root), scene: 'StillExample' });
    const { frame, timeline } = await inspect(job, { time: 0, timeline: true }, signal);
    assert.equal(timeline?.timeline.duration, 0); assert.deepEqual(timeline?.timeline.entries, []);
    assert.equal(frame?.media.capture?.time, null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('source mutation and user errors never publish a timeline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-failure-')); const source = path.join(root, 'scene.py');
  try {
    for (const body of ['raise RuntimeError("user failed")', 'Path(__file__).write_text("changed")']) {
      await fs.writeFile(source, `from pathlib import Path\nfrom manim import Scene\nclass Demo(Scene):\n    def construct(self):\n        self.wait(.25)\n        ${body}\n`);
      const job = await createJob(options(source, path.join(root, 'runs')));
      await assert.rejects(inspect(job, { timeline: true }, signal), /user failed|scene file changed/);
      assert.deepEqual((await fs.readdir(job.directory)).filter(f => f.startsWith('timeline')), []);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
