import * as vscode from 'vscode';
import * as path from 'node:path';
import { environmentFor } from './environment';
import { runProcess } from './process';
import { discoverScenes, isNotebook, notebookOfCell, type NotebookScene } from './notebook';
export interface Candidate { name: string; line: number }
/** Finds the scene classes of a Python file or of the cells of a notebook, and shows "▶ Open Manim Cue" above them. */
export class Scenes implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly cache = new Map<string, { version: string; scenes: Candidate[] | NotebookScene[] }>();
  private readonly active = new Set<AbortController>();
  constructor(private readonly helpers: string) {}
  invalidate(): void { this.cache.clear(); for (const c of this.active) c.abort(); this.changed.fire(); }
  private async cached<T extends Candidate[] | NotebookScene[]>(key: string, version: string, find: (signal: AbortSignal) => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
    const hit = this.cache.get(key); if (hit?.version === version) return hit.scenes as T;
    const abort = new AbortController(); this.active.add(abort);
    const subscription = token?.onCancellationRequested(() => abort.abort());
    try {
      await new Promise(resolve => setTimeout(resolve, 180));
      if (token?.isCancellationRequested) return [] as unknown as T;
      const scenes = await find(abort.signal);
      if (abort.signal.aborted) return [] as unknown as T;
      this.cache.set(key, { version, scenes });
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      return scenes;
    } finally { subscription?.dispose(); this.active.delete(abort); }
  }
  async candidates(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<Candidate[]> {
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file' || document.getText().length > 2 * 1024 * 1024) return [];
    const source = document.getText(), version = document.version;
    if (!/\bmanim\b/.test(source)) return [];
    const scenes = await this.cached(document.uri.toString(), String(version), async signal => {
      const { python, env } = await environmentFor(document.uri);
      const output = await runProcess(python, ['-I', '-S', path.join(this.helpers, 'discover.py')], {
        cwd: path.dirname(document.uri.fsPath), env, signal, timeout: 5000, input: source,
      });
      return (JSON.parse(output) as { scenes: Candidate[] }).scenes;
    }, token);
    return document.version === version ? scenes : [];
  }
  /** The scenes of a notebook: each with its cell and its line in the cell. */
  async notebookScenes(notebook: vscode.NotebookDocument, token?: vscode.CancellationToken): Promise<NotebookScene[]> {
    if (!vscode.workspace.isTrusted || notebook.uri.scheme !== 'file') return [];
    if (!notebook.getCells().some(cell => /\bmanim\b/.test(cell.document.getText()))) return [];
    // Cell edits change the notebook's version.
    return this.cached(notebook.uri.toString(), `notebook ${notebook.version}`,
      async signal => discoverScenes(await environmentFor(notebook.uri), this.helpers, notebook, signal), token);
  }
  /** The scene class of the file: the only one, or the one that the user selects or enters. */
  async pick(uri: vscode.Uri): Promise<string | undefined> {
    const candidates = isNotebook(uri) ? await this.notebookScenes(await vscode.workspace.openNotebookDocument(uri))
      : await this.candidates(await vscode.workspace.openTextDocument(uri));
    const names = [...new Set(candidates.map(c => c.name))];
    let scene = names.length === 1 ? names[0] : await vscode.window.showQuickPick([...names, 'Enter scene name…'], { placeHolder: 'Select a scene' });
    if (scene === 'Enter scene name…') scene = await vscode.window.showInputBox({ prompt: 'Name of the scene class' });
    return scene;
  }
  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    try {
      const notebook = document.uri.scheme === 'vscode-notebook-cell' ? notebookOfCell(document) : undefined;
      if (notebook) {
        const cell = notebook.getCells().find(c => c.document === document);
        return (await this.notebookScenes(notebook, token)).filter(scene => scene.cell === cell?.index).map(scene => this.lens(notebook.uri, scene));
      }
      return (await this.candidates(document, token)).map(scene => this.lens(document.uri, scene));
    } catch { return []; } // The explicit Open command provides actionable environment errors.
  }
  private lens(uri: vscode.Uri, scene: Candidate): vscode.CodeLens {
    return new vscode.CodeLens(new vscode.Range(scene.line - 1, 0, scene.line - 1, 0), {
      title: '▶ Open Manim Cue', command: 'manimCue.open', arguments: [uri, scene.name],
    });
  }
  dispose(): void { this.invalidate(); this.changed.dispose(); }
}
