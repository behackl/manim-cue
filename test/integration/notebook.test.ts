import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJob, inspect, NotebookError, renderPreview, type JobOptions } from '../../src/jobs';
import { runProcess } from '../../src/process';
import { locate, type CellMode } from '../../src/notebook-problem';
import { isCall } from '../../src/timeline';

const python = process.env.MANIM_PYTHON;
if (!python) throw new Error('Set MANIM_PYTHON to the executable of a supported Manim environment; integration tests are not silently skipped.');
const signal = new AbortController().signal;
const helpers = path.resolve('python');

const code = (source: string) => ({ cell_type: 'code', source, outputs: [], execution_count: null, metadata: {} });
async function notebook(dir: string, ...cells: Array<string | { markdown: string }>): Promise<string> {
  const file = path.join(dir, 'scenes.ipynb');
  await fs.writeFile(file, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: cells.map(c => typeof c === 'string' ? code(c) : { cell_type: 'markdown', source: c.markdown, metadata: {} }) }));
  return file;
}
/** The hash that the extension computes for a notebook run. */
async function hash(file: string, scene: string, mode: CellMode): Promise<string> {
  const output = await runProcess(python!, ['-I', '-S', path.join(helpers, 'cue_notebook.py'), 'hash'], {
    cwd: helpers, signal, timeout: 10000, input: JSON.stringify({ path: file, scene, mode }) });
  return (JSON.parse(output) as { hash: string }).hash;
}
async function job(file: string, scene: string, cells: CellMode = 'needed', scratch = path.join(path.dirname(file), 'runs')) {
  const o: JobOptions = { python: python!, source: file, scene, cwd: path.dirname(file), fps: 4, width: 128, timeout: 60000,
    env: process.env, helpers, scratch, signal, log: () => {}, cells };
  return createJob(o, await hash(file, scene, cells));
}
const SCENE = `%%manim -qm Orbit
class Orbit(Scene):
    def construct(self):
        self.play(Create(Circle(radius=RADIUS)), run_time=1)
        self.wait(0.5)`;

test('the example notebook runs only the cells that the scene needs; a timeline entry finds its cell', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-notebook-'));
  try {
    const file = path.join(root, 'cue_notebook.ipynb');
    await fs.copyFile('examples/cue_notebook.ipynb', file);
    const j = await job(file, 'Orbit');
    // The example has a cell that raises: the run succeeds only if Cue skips it.
    const { frame, timeline } = await inspect(j, { time: 1.25, timeline: true }, signal);
    assert.equal(frame?.media.capture?.time, 1.25);
    assert.deepEqual(timeline!.timeline.entries.filter(isCall).map(e => [e.start, e.end]), [[0, 1], [1, 2], [2, 2.5]]);
    const play = timeline!.timeline.entries.find(isCall)!;
    const cell = await locate(j.directory, play.source!.path!, play.source!.line);
    assert.deepEqual([cell?.index, cell?.line, cell?.first], [4, 6, 'class Orbit(Scene):'], 'the play() line of the scene cell');
    const { video } = await renderPreview(j, signal);
    assert.equal(video.media.duration, 2.5);
    // All cells above: the cell that raises runs, and the error names it.
    await assert.rejects(inspect(await job(file, 'Orbit', 'allAbove'), { timeline: true }, signal), (error: Error) => {
      assert.ok(error instanceof NotebookError);
      assert.match(error.message, /This cell must not run.*line 2 of the cell starting with “raise RuntimeError/u);
      assert.equal(error.problem.location?.index, 2);
      return true;
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a NameError names the skipped cell, and running all cells above fixes it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-notebook-'));
  try {
    const file = await notebook(root, 'from manim import *', { markdown: '# Setup' }, "exec('RADIUS = 1')", SCENE);
    await assert.rejects(inspect(await job(file, 'Orbit'), { timeline: true }, signal), (error: Error) => {
      assert.ok(error instanceof NotebookError);
      assert.match(error.message, /NameError: name 'RADIUS' is not defined.*line 4 of the cell starting with “class Orbit\(Scene\):”/u);
      assert.deepEqual([error.problem.name, error.problem.reason, error.problem.cell?.index], ['RADIUS', 'skipped', 2]);
      return true;
    });
    const { timeline } = await inspect(await job(file, 'Orbit', 'allAbove'), { timeline: true }, signal);
    assert.equal(timeline!.timeline.duration, 1.5);
    // The marker runs that cell too.
    const marked = await notebook(root, 'from manim import *', "# cue: run\nexec('RADIUS = 1')", SCENE);
    assert.equal((await inspect(await job(marked, 'Orbit'), { timeline: true }, signal)).timeline!.timeline.duration, 1.5);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a NameError of a name set below the scene, or inside Manim, is explained or left alone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-notebook-'));
  try {
    const below = await notebook(root, 'from manim import *', SCENE, 'RADIUS = 1');
    await assert.rejects(inspect(await job(below, 'Orbit'), { timeline: true }, signal), (error: Error) =>
      error instanceof NotebookError && error.problem.reason === 'below' && error.problem.cell?.index === 2);
    // A NameError raised in another module is not about the notebook's cells.
    await fs.writeFile(path.join(root, 'helper.py'), 'def radius():\n    return MISSING\n');
    const other = await notebook(root, 'from manim import *\nfrom helper import radius', SCENE.replace('RADIUS', 'radius()'));
    await assert.rejects(inspect(await job(other, 'Orbit'), { timeline: true }, signal), (error: Error) => {
      assert.ok(error instanceof NotebookError, 'the notebook imports from its folder');
      assert.equal(error.problem.reason, undefined);
      assert.equal(error.problem.location?.index, 1, 'the deepest notebook line is the call in the scene cell');
      return true;
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a changed notebook during the update stops it; outputs and other cells do not', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-notebook-'));
  try {
    const file = await notebook(root, 'from manim import *', 'RADIUS = 1', 'unused = 1', SCENE);
    const j = await job(file, 'Orbit');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: 'ran' }]; data.cells[0].execution_count = 7;
    data.cells[2].source = 'unused = 2';
    await fs.writeFile(file, JSON.stringify(data));
    assert.equal((await inspect(j, { timeline: true }, signal)).timeline!.timeline.duration, 1.5);
    data.cells[1].source = 'RADIUS = 2';
    await fs.writeFile(file, JSON.stringify(data));
    await assert.rejects(inspect(j, { timeline: true }, signal), /The scene file changed during the update/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
