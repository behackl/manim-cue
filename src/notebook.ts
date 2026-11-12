import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { runProcess } from './process';
import type { PythonEnvironment } from './environment';
import { isNotebook, MARKER, type CellMode, type CellRef } from './notebook-problem';
export * from './notebook-problem';

export function notebookFor(uri: vscode.Uri): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find(n => n.uri.toString() === uri.toString());
}
/** The notebook of a cell document. */
export function notebookOfCell(document: vscode.TextDocument): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find(n => n.getCells().some(c => c.document === document));
}
/** The scene file or the notebook has unsaved changes. */
export function isDirty(uri: vscode.Uri): boolean {
  return isNotebook(uri) ? !!notebookFor(uri)?.isDirty
    : vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
}
/** Saves the scene file or the notebook. */
export async function save(uri: vscode.Uri): Promise<boolean> {
  return isNotebook(uri) ? (await vscode.workspace.openNotebookDocument(uri)).save() : (await vscode.workspace.openTextDocument(uri)).save();
}
const text = (cell: vscode.NotebookCell) => cell.document.getText().replace(/\r\n/gu, '\n');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** The code cells of the editor, as the helper reads them from a saved notebook. */
export function editorCells(notebook: vscode.NotebookDocument): Array<[number, string]> {
  return notebook.getCells().filter(c => c.kind === vscode.NotebookCellKind.Code && c.document.languageId !== 'raw').map(c => [c.index, text(c)]);
}

/** Runs python/cue_notebook.py; it reads notebooks as data and never runs their code. */
async function helper<T>(environment: PythonEnvironment, helpers: string, command: 'hash' | 'discover', input: object, signal?: AbortSignal): Promise<T> {
  const output = await runProcess(environment.python, ['-I', '-S', path.join(helpers, 'cue_notebook.py'), command], { cwd: helpers,
    env: environment.env, signal: signal ?? new AbortController().signal, timeout: 10000, input: JSON.stringify(input),
  });
  return JSON.parse(output) as T;
}
/**
 * The hash of the code that a run of `scene` executes: of the saved notebook, or of the
 * editor's cells. Outputs, execution counts and cells that the run leaves out do not count.
 */
export async function codeHash(environment: PythonEnvironment, helpers: string, scene: string, mode: CellMode,
  source: { path: string } | { cells: Array<[number, string]> }, signal?: AbortSignal): Promise<string> {
  return (await helper<{ hash: string }>(environment, helpers, 'hash', { ...source, scene, mode }, signal)).hash;
}
export interface NotebookScene { name: string; cell: number; line: number }
export async function discoverScenes(environment: PythonEnvironment, helpers: string, notebook: vscode.NotebookDocument, signal?: AbortSignal): Promise<NotebookScene[]> {
  return (await helper<{ scenes: NotebookScene[] }>(environment, helpers, 'discover', { cells: editorCells(notebook) }, signal)).scenes;
}

/** The cell of `ref` in the editor, if its code is unchanged: by index, or else by its text. */
export function findCell(notebook: vscode.NotebookDocument, ref: CellRef): vscode.NotebookCell | undefined {
  const cells = notebook.getCells(), same = (c?: vscode.NotebookCell) => !!c && c.kind === vscode.NotebookCellKind.Code && sha(text(c)) === ref.sha;
  return same(cells[ref.index]) ? cells[ref.index] : cells.find(same);
}
/** Shows a cell of the notebook and selects `line` (1-based) in it. */
export async function showCell(uri: vscode.Uri, ref: CellRef, line = 1, column?: vscode.ViewColumn): Promise<void> {
  const notebook = await vscode.workspace.openNotebookDocument(uri), cell = findCell(notebook, ref);
  if (!cell) throw new Error('This cell changed. Refresh to update.');
  await vscode.window.showNotebookDocument(notebook, { viewColumn: column, selections: [new vscode.NotebookRange(cell.index, cell.index + 1)] });
  const position = new vscode.Position(Math.min(line, cell.document.lineCount) - 1, 0);
  await vscode.window.showTextDocument(cell.document, { viewColumn: column, selection: new vscode.Range(position, position) });
}
/** Adds the marker that makes Cue run the cell. The notebook stays unsaved: a save updates. */
export async function markCell(uri: vscode.Uri, ref: CellRef, column?: vscode.ViewColumn): Promise<void> {
  const notebook = await vscode.workspace.openNotebookDocument(uri), cell = findCell(notebook, ref);
  if (!cell) throw new Error('This cell changed. Refresh to update.');
  const edit = new vscode.WorkspaceEdit(); edit.insert(cell.document.uri, new vscode.Position(0, 0), `${MARKER}\n`);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('The cell cannot be changed.');
  await showCell(uri, { ...ref, sha: sha(text(cell)) }, 1, column);
}

