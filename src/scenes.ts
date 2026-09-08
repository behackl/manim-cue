import * as vscode from 'vscode';
import * as path from 'node:path';
import { environmentFor } from './environment';
import { runProcess } from './process';
export interface Candidate { name: string; line: number }
export class Scenes implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly cache = new Map<string, { version: number; scenes: Candidate[] }>();
  private readonly active = new Set<AbortController>();
  constructor(private readonly helper: string) {}
  invalidate(): void { this.cache.clear(); for (const c of this.active) c.abort(); this.changed.fire(); }
  async candidates(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<Candidate[]> {
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file' || document.getText().length > 2 * 1024 * 1024) return [];
    const key = document.uri.toString(), version = document.version;
    const cached = this.cache.get(key); if (cached?.version === version) return cached.scenes;
    const source = document.getText();
    if (!/\bmanim\b/.test(source)) return [];
    const abort = new AbortController(); this.active.add(abort);
    const subscription = token?.onCancellationRequested(() => abort.abort());
    try {
      await new Promise(resolve => setTimeout(resolve, 180));
      if (token?.isCancellationRequested) return [];
      const { python, env } = await environmentFor(document.uri);
      const output = await runProcess(python, ['-I', '-S', this.helper], {
        cwd: path.dirname(document.uri.fsPath), env, signal: abort.signal, timeout: 5000, input: source,
      });
      const { scenes } = JSON.parse(output) as { scenes: Candidate[] };
      if (document.version !== version || abort.signal.aborted) return [];
      this.cache.set(key, { version, scenes });
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      return scenes;
    } finally { subscription?.dispose(); this.active.delete(abort); }
  }
  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    try {
      return (await this.candidates(document, token)).map(scene => new vscode.CodeLens(new vscode.Range(scene.line - 1, 0, scene.line - 1, 0), {
        title: '▶ Open Manim Cue', command: 'manimCue.open', arguments: [document.uri, scene.name],
      }));
    } catch { return []; } // The explicit Open command provides actionable environment errors.
  }
  dispose(): void { this.invalidate(); this.changed.dispose(); }
}
