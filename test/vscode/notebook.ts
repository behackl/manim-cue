import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { Model } from '../../src/protocol';
import { isCall } from '../../src/timeline';

export interface NotebookApi {
  getSnapshot(): Model; whenIdle(): Promise<void>; setSaveDelay(ms: number): void;
  setCells(mode: 'needed' | 'allAbove'): Promise<void>; problemAction(action: 'showCell' | 'runCell' | 'runAllAbove'): Promise<void>;
}

/** A scene in a notebook: which cells run, what makes results outdated, and the help for a NameError. */
export async function testNotebook(api: NotebookApi, root: string): Promise<void> {
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate: () => boolean, reason: string) => {
    for (let i = 0; i < 6000 && !predicate(); i++) await pause(10);
    assert.ok(predicate(), `${reason}: ${JSON.stringify({ ...api.getSnapshot(), timeline: undefined })}`);
  };
  const updated = () => until(() => !api.getSnapshot().busy && !api.getSnapshot().timelineOutdated && !api.getSnapshot().error, 'the update finishes');
  const uri = vscode.Uri.file(path.join(root, 'cue_notebook.ipynb'));
  // The suite before turned automatic updates off.
  await vscode.workspace.getConfiguration('manimCue', uri).update('autoRefreshOnSave', true, vscode.ConfigurationTarget.Workspace);
  api.setSaveDelay(100);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  const editor = await vscode.window.showNotebookDocument(notebook);
  const cell = (index: number) => notebook.cellAt(index);
  const setCell = async (index: number, text: string) => {
    const edit = new vscode.WorkspaceEdit(), document = cell(index).document;
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };

  // "▶ Open Manim Cue" above the scene class in its cell, as in a Python file. The
  // notebook editor makes the text model of a cell when it draws the cell.
  editor.revealRange(new vscode.NotebookRange(4, 5), vscode.NotebookEditorRevealType.AtTop);
  editor.selections = [new vscode.NotebookRange(4, 5)];
  let lenses: vscode.CodeLens[] = [];
  for (let attempt = 0; attempt < 100 && !lenses.length; attempt++) {
    lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', cell(4).document.uri, 100).then(l => l, () => []); // Until the editor draws the cell.
    if (!lenses.length) await pause(100);
  }
  assert.deepEqual(lenses.map(l => [l.range.start.line, l.command?.command, l.command?.arguments?.[1]]), [[1, 'manimCue.open', 'Orbit']]);
  assert.equal(lenses[0].command?.arguments?.[0].toString(), uri.toString(), 'the lens opens the notebook, not the cell');

  // The example's cell that raises shows that the run skips cells that the scene does not need.
  await vscode.commands.executeCommand('manimCue.open', uri, 'Orbit'); await api.whenIdle();
  let state = api.getSnapshot();
  assert.equal(state.error, undefined, state.error); assert.equal(state.cells, 'needed');
  assert.deepEqual(state.timeline?.entries.filter(isCall).map(e => [e.start, e.end]), [[0, 1], [1, 2], [2, 2.5]]);

  // An edit of a cell that the run skips leaves the results up to date, also after a save.
  await setCell(2, "raise RuntimeError('This cell must not run, still')");
  await pause(1000); await api.whenIdle();
  assert.equal(api.getSnapshot().timelineOutdated, false, 'a skipped cell is not part of the run');
  const before = api.getSnapshot().timelineId;
  assert.equal(await notebook.save(), true); await pause(1000); await api.whenIdle();
  assert.equal(api.getSnapshot().timelineId, before, 'saving a change of a skipped cell starts no update');
  assert.equal(api.getSnapshot().timelineOutdated, false, 'and keeps the results up to date');

  // A cell that the scene uses: outdated at once, updated when saved.
  await setCell(3, 'RADIUS = 2\nCOLORS = [TEAL, YELLOW]');
  await until(() => api.getSnapshot().timelineOutdated, 'an edit of a needed cell makes the results outdated');
  assert.equal(await notebook.save(), true); await updated();
  assert.notEqual(api.getSnapshot().timelineId, before);

  // A NameError: Cue names the skipped cell and offers to run it. The scene needs no other
  // name of that cell, so the cell is skipped.
  await setCell(1, 'from manim import *\nCOLORS = [TEAL, YELLOW]');
  await setCell(3, "exec('RADIUS = 2')");
  assert.equal(await notebook.save(), true);
  await until(() => !api.getSnapshot().busy && !!api.getSnapshot().problem, 'the error explains the NameError');
  state = api.getSnapshot();
  assert.match(state.error!, /NameError: name 'RADIUS' is not defined \(line 4 of the cell starting with “class Orbit\(Scene\):”\)/u);
  assert.match(state.problem!.text, /The cell starting with “exec\('RADIUS = 2'\)” may set “RADIUS”, but Cue skipped it/u);
  assert.deepEqual(state.problem!.actions, ['runCell', 'runAllAbove', 'showCell']);
  await api.problemAction('showCell');
  assert.equal(vscode.window.activeNotebookEditor?.selection.start, 3, 'Show Cell selects the cell');
  await api.problemAction('runCell');
  assert.equal(cell(3).document.lineAt(0).text, '# cue: run');
  assert.equal(notebook.isDirty, true, 'Cue never saves the notebook');
  assert.equal(api.getSnapshot().busy, false, 'the unsaved marker starts no update');
  assert.equal(await notebook.save(), true); await updated();
  assert.equal(api.getSnapshot().problem, undefined);

  // All cells above: switching runs at once, here into the cell that raises.
  await api.setCells('allAbove'); await api.whenIdle();
  state = api.getSnapshot();
  assert.equal(state.cells, 'allAbove');
  assert.match(state.error ?? '', /This cell must not run, still \(line 1 of the cell starting with “raise RuntimeError/u);
  await api.setCells('needed'); await updated();
  assert.equal(api.getSnapshot().cells, 'needed');
}
