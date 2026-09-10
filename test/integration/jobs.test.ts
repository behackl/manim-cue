import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJob, captureFrame, publishPreview, executeJob, renderExport, type JobOptions, type RunResult } from '../../src/jobs';
import { pairingReason } from '../../src/timeline';
import { runProcess } from '../../src/process';
import { checkPython } from '../../src/diagnostics';
const python = process.env.MANIM_PYTHON;
if (!python) throw new Error('Set MANIM_PYTHON to the executable of a supported Manim environment; integration tests are not silently skipped.');
const options = (source: string, scratch: string): JobOptions => ({
  python: python!, source, scene: 'Demo', cwd: path.dirname(source), fps: 4, width: 128,
  timeout: 60000, preview: true, env: process.env, helpers: path.resolve('python'), scratch,
  signal: new AbortController().signal, log: () => {}, phase: () => {}, timelineReady: () => {},
});

test('independent export renders requested dimensions/FPS/audio and replaces inherited encoder options without a timeline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-export-native-'));
  try {
    const source = path.join(root, 'scene.py');
    await fs.copyFile('examples/cue.wav', path.join(root, 'cue.wav'));
    await fs.writeFile(source, 'from manim import Scene, Square, config\nclass Demo(Scene):\n    def construct(self):\n        assert config.frame_rate == 12\n        self.add(Square())\n        self.add_sound("cue.wav")\n        self.wait(1)\n');
    await fs.writeFile(path.join(root, 'manim.cfg'), '[CLI]\npixel_width=640\npixel_height=480\nframe_rate=4\npreview=True\nformat=png\nseed=42\n[video_encoder]\ncodec=libvpx-vp9\n[video_encoder.options]\ncrf=40\ndeadline=realtime\n');
    const settings = { width: 320, height: 192, fps: 12, crf: 18, preset: 'medium' as const, options: 'threads=1' };
    const job = await createJob({ ...options(source, path.join(root, 'runs')), width: settings.width, fps: settings.fps, exportSettings: settings });
    const result = await renderExport(job, job.options.signal);
    assert.equal(result.profile.width, 320); assert.equal(result.profile.height, 192); assert.equal(result.profile.seed, 42);
    assert.equal(result.media.rate, 12); assert.equal(result.media.frames, 12); assert.equal(result.media.hasAudio, true);
    assert.equal(result.media.frameTimes, null, 'production exports do not retain a bounded preview PTS table');
    await assert.rejects(fs.stat(path.join(job.directory, 'timeline.json')), /ENOENT/);
    const cfg = await fs.readFile(path.join(job.directory, 'cue.cfg'), 'utf8');
    assert.match(cfg, /crf = 18/); assert.match(cfg, /preset = medium/); assert.match(cfg, /threads = 1/); assert.doesNotMatch(cfg, /deadline/);
    assert.match(await fs.readFile(path.join(root, 'manim.cfg'), 'utf8'), /codec=libvpx-vp9/, 'project config is untouched');
    const broken = await createJob({ ...job.options, exportSettings: { ...settings, options: 'profile=not-a-profile' } });
    await assert.rejects(renderExport(broken, broken.options.signal), /Python exited/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('real evaluation + encoded preview preserves reached spans, source occurrences and cue placement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-integration-'));
  try {
    let observation: RunResult | undefined;
    const result = await executeJob({ ...options(path.resolve('examples/cue_demo.py'), root), scene: 'CueDemo', timelineReady: r => { observation = r; assert.equal(r.media, undefined); } });
    assert.deepEqual(result.timeline.events.map(e => [e.start, e.end, e.samples, e.hold_intervals]), [
      [0, 1, 4, 0], [1, 1.5, 2, 0], [1.5, 2, 2, 0], [2, 2.5, 2, 0], [2.5, 2.75, 0, 1], [2.75, 3.5, 3, 0],
    ]);
    assert.deepEqual(result.timeline.events.slice(1, 3).map(e => e.source?.occurrence), [0, 1]);
    const cue = result.timeline.declarations.find(d => d.kind === 'sound');
    assert.equal(cue?.at, 2);
    assert.equal(cue?.kind === 'sound' && cue.start, 1.75);
    assert.equal(cue?.kind === 'sound' && cue.duration, null);
    assert.equal(result.media?.duration, 3.5); assert.equal(result.media?.hasAudio, true);
    assert.equal(pairingReason(result.timeline, result.media!.duration, result.media!.rate, result.media!.maxFrameTimeError), null);
    assert.equal(observation?.media, undefined, 'do not mutate a published observation while preparing media');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('fractional 30 fps runs stay linkable after probing actual movie timestamps', async () => {
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
    const r = await executeJob({ ...options(source, path.join(root, 'runs')), fps: 30 });
    assert.deepEqual(r.timeline.events.map(e => [e.samples, e.hold_intervals]), [[29, 0], [0, 19], [11, 0], [0, 19], [35, 0], [0, 19]]);
    assert.equal(r.media!.frames, 132);
    assert.equal(r.media!.rate, 30);
    assert.equal(pairingReason(r.timeline, r.media!.duration, r.media!.rate, r.media!.maxFrameTimeError), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('controlled profile redirects output, disables inherited preview/skip and avoids stale primary bytecode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-config-'));
  const source = path.join(root, 'scene.py');
  try {
    const code = 'from manim import Scene\nclass Demo(Scene):\n    def construct(self): self.wait(1, frozen_frame=False)\n';
    await fs.writeFile(source, code); const stat = await fs.stat(source);
    await runProcess(python!, ['-c', 'import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)', source], { cwd: root, timeout: 5000, signal: new AbortController().signal });
    await fs.writeFile(source, code.replace('wait(1', 'wait(2')); await fs.utimes(source, stat.atime, stat.mtime);
    const outside = path.join(root, 'must-not-write');
    await fs.writeFile(path.join(root, 'manim.cfg'), `[CLI]\nformat=png\ndry_run=True\npreview=True\nlive_preview=True\nwrite_all=True\nfrom_animation_number=3\nvideo_dir=${outside}\npartial_movie_dir=${outside}\noutput_file=${outside}/bad\nseed=19\nframe_width=12\nframe_height=6\n`);
    const r = await executeJob(options(source, path.join(root, 'runs')));
    assert.equal(r.timeline.end, 2); assert.equal(r.media?.duration, 2); assert.equal(r.profile.seed, 19);
    assert.equal(r.profile.frameWidth, 12); assert.equal(r.profile.frameHeight, 6.75, 'Cairo derives the reference height from frame width and pixel aspect');
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
    const initial = await executeJob(options(source, path.join(root, 'runs')));
    assert.equal(initial.media!.duration, 1);
    const cache = path.join(root, 'runs', 'cache-v1');
    const svg = (await collect(cache, '.svg'))[0]; assert.ok(svg, 'typesetting produced a cache entry');
    await fs.writeFile(path.join(root, 'layout-warm'), '');
    const pyc = (await collect(cache, '.pyc')).find(p => p.includes('duration_helper.'))!;
    assert.equal((await fs.readFile(pyc)).readUInt32LE(4), 3, 'checked-hash pyc, not a timestamp cache');
    for (const [file, text] of [[source, code.replace('* 1', '* 2')], [helper, 'duration = 2\n']]) {
      const stat = await fs.stat(file); await fs.writeFile(file, text); await fs.utimes(file, stat.atime, stat.mtime);
    }
    const updated = await executeJob(options(source, path.join(root, 'runs')));
    assert.equal(updated.timeline.end, 4); assert.equal(updated.media!.duration, 4);
    assert.ok(await fs.stat(svg), 'cached layout is reused (the real layout function would raise)');
    const header = (await fs.readFile(pyc)).subarray(0, 16);
    await fs.writeFile(pyc, header); // Valid hash header, broken marshal payload.
    const repaired = await executeJob({ ...options(source, path.join(root, 'runs')), preview: false });
    assert.equal(repaired.timeline.end, 4, 'a corrupt cache falls back to fresh source');
    await fs.rm(path.join(root, 'layout-warm'));
    await fs.writeFile(path.join(root, 'manim.cfg'), '[CLI]\nseed=17\n');
    const configured = await executeJob({ ...options(source, path.join(root, 'runs')), preview: false });
    assert.equal(configured.profile.seed, 17);
    assert.ok((await collect(cache, '.svg')).length > 1, 'changed config gets a new asset cache namespace');
    await fs.writeFile(source, code + '\nraise RuntimeError("failed after layout cache was warmed")\n');
    await assert.rejects(executeJob({ ...options(source, path.join(root, 'runs')), preview: false }));
    assert.equal((await collect(cache, '.svg')).length, 0, 'failed work cannot poison the next run with partial SVGs');
    assert.ok((await collect(cache, '.pyc')).length > 0, 'atomic checked bytecode remains reusable');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('doctor reports the actual runtime in another folder without executing scene code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-doctor-test-'));
  try {
    await fs.writeFile(path.join(root, 'scene.py'), 'raise RuntimeError("scene must not execute")\n');
    const report = await checkPython({ python: python!, env: process.env, cwd: root,
      helpers: path.resolve('python'), signal: new AbortController().signal, log: () => {} });
    assert.equal(report.status, 'ready', JSON.stringify(report));
    assert.equal(await fs.realpath(report.python), await fs.realpath(python!));
    assert.equal(await fs.realpath(report.cwd), await fs.realpath(root));
    assert.ok(report.manim_module?.endsWith('__init__.py'));
    // -S provides a clean stdlib-only import path, independent of installed packages.
    const output = path.join(root, 'without-site.json');
    await runProcess(python!, ['-I', '-S', path.resolve('python/support.py'), 'diagnose', '-', output], {
      cwd: root, timeout: 10000, signal: new AbortController().signal,
    });
    const missing = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(missing.status, 'missing-manim');
    assert.ok(missing.python); assert.match(missing.error, /No module named 'manim'/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('public frame capture publishes before a timeline and checks fresh source and misses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-capture-'));
  try {
    const source = path.join(root, 'scene.py');
    await fs.writeFile(source, 'from manim import Scene, Square, RIGHT\nclass Demo(Scene):\n    def construct(self):\n        s = Square()\n        self.add(s)\n        self.play(s.animate.shift(RIGHT))\n');
    const job = await createJob(options(source, path.join(root, 'runs')));
    const frame = await captureFrame(job, .3);
    assert.equal(frame?.media.kind, 'image');
    assert.deepEqual(frame?.media.capture, { requestedTime: .3, time: .25, frameIndex: 1 });
    await assert.rejects(fs.stat(path.join(job.directory, 'timeline.json')), /ENOENT/);
    const miss = await captureFrame(job, 10);
    assert.deepEqual(miss?.media.capture, { requestedTime: 10, time: null, frameIndex: null });
    const stat = await fs.stat(source);
    await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('RIGHT))', 'RIGHT), run_time=2)'));
    await fs.utimes(source, stat.atime, stat.mtime);
    await assert.rejects(captureFrame(job, .3), /Primary source changed/);
    const updated = await captureFrame(await createJob(options(source, path.join(root, 'runs'))), 1.25);
    assert.equal(updated?.media.capture?.time, 1.25);
    const mediaRoot = path.join(root, 'preview-media');
    const published = await publishPreview(frame!, mediaRoot);
    const bytes = await fs.readFile(frame!.media.path);
    await fs.writeFile(frame!.media.path, 'obsolete worker output');
    await fs.rm(job.directory, { recursive: true });
    assert.deepEqual(await fs.readFile(published.media.path), bytes, 'published pixels outlive worker output');
    assert.deepEqual(await fs.readdir(mediaRoot), [path.basename(published.media.path)], 'only media is exposed to the webview');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('zero-time scene gets a labeled still, not a fabricated movie', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-still-'));
  try {
    const r = await executeJob({ ...options(path.resolve('examples/cue_demo.py'), root), scene: 'StillExample' });
    assert.equal(r.timeline.end, 0); assert.equal(r.timeline.events.length, 0);
    assert.equal(r.media?.kind, 'image'); assert.equal(r.media?.duration, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('source mutation and user errors never publish successful-looking observations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-failure-')); const source = path.join(root, 'scene.py');
  try {
    for (const body of ['raise RuntimeError("user failed")', 'Path(__file__).write_text("changed")']) {
      await fs.writeFile(source, `from pathlib import Path\nfrom manim import Scene\nclass Demo(Scene):\n    def construct(self):\n        self.wait(.25)\n        ${body}\n`);
      let published = false;
      await assert.rejects(executeJob({ ...options(source, path.join(root, 'runs')), timelineReady: () => { published = true; } }));
      assert.equal(published, false);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
