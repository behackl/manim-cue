import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// The parts of notebook support without VS Code: unit tests and jobs.ts import them.

/** Which cells above the scene cell run: the cells that the scene needs, or all of them. */
export type CellMode = 'needed' | 'allAbove';
/** A cell of the saved notebook: its index among all cells, the hash of its text and its first line of code. */
export interface CellRef { index: number; sha: string; first: string }
export interface Location extends CellRef { line: number }
/** Why a notebook run failed, from python/support.py. */
export interface Problem {
  location?: Location | null;
  name?: string;
  reason?: 'below' | 'skipped' | 'magic' | 'notPython' | 'unknown';
  cell?: CellRef | null;
}
export type ProblemAction = 'showCell' | 'runCell' | 'runAllAbove';
export const MARKER = '# cue: run';

export const isNotebook = (uri: { fsPath: string }) => uri.fsPath.toLowerCase().endsWith('.ipynb');

/** The run's map from lines of the generated file to cells. */
interface Segment { cell: number; sha: string; first: string; start: number; count: number }
/** The cell and the line in it for a line of the generated file of a run, or undefined. */
export async function locate(run: string, file: string, line: number): Promise<Location | undefined> {
  const built = JSON.parse(await fs.readFile(path.join(run, 'notebook', 'notebook.json'), 'utf8')) as { segments: Segment[] };
  if (path.basename(file) !== file || !file.endsWith('.py')) return undefined;
  const segment = built.segments.find(s => s.start <= line && line < s.start + s.count);
  return segment && { index: segment.cell, sha: segment.sha, first: segment.first, line: line - segment.start + 1 };
}

const quote = (s: string) => `“${s.length > 40 ? s.slice(0, 39) + '…' : s}”`;
/** Names a cell for messages: VS Code shows no cell numbers, and execution counts change. */
export const cellName = (ref: CellRef) => ref.first ? `the cell starting with ${quote(ref.first)}` : 'an empty cell';
/** The place of an error, for the error line. */
export const where = (location: Location) => `line ${location.line} of ${cellName(location)}`;
/** The explanation of a NameError in a notebook and the actions that can fix it. */
export function explain(problem: Problem, mode: CellMode): { text: string; actions: ProblemAction[] } | undefined {
  const name = problem.name && `“${problem.name}”`, cell = problem.cell;
  if (!name || !problem.reason) return undefined;
  switch (problem.reason) {
    case 'below': return { text: `${name} is set in ${cellName(cell!)}, below the scene. Cue runs only cells above the scene cell: move that cell up.`, actions: ['showCell'] };
    case 'magic': return { text: `${name} comes from an IPython command in ${cellName(cell!)}. Cue cannot run IPython commands: write it as Python.`, actions: ['showCell'] };
    case 'notPython': return { text: `${cellName(cell!)[0].toUpperCase()}${cellName(cell!).slice(1)} may set ${name}, but it is not Python that Cue can run.`, actions: ['showCell'] };
    case 'skipped': return { text: `${cellName(cell!)[0].toUpperCase()}${cellName(cell!).slice(1)} may set ${name}, but Cue skipped it: Cue runs only the cells that the scene needs.`, actions: ['runCell', 'runAllAbove', 'showCell'] };
    case 'unknown': return mode === 'needed'
      ? { text: `If a cell sets ${name} in a way that Cue cannot see, add “${MARKER}” as its first line, or run all cells above.`, actions: ['runAllAbove'] }
      : undefined;
  }
}
