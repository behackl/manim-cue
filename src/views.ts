import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HostMessage, Model } from './protocol';

export class Views implements vscode.Disposable {
  private timeline?: vscode.WebviewView;
  private preview?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly updated = new vscode.EventEmitter<void>();
  /** Fires after each update of the webviews, also without an open view. */
  readonly onDidUpdate = this.updated.event;
  /** The timeline that the timeline view has. A timeline is large: send it only when it changes. */
  private sent?: string;
  constructor(private readonly root: vscode.Uri, private readonly mediaRoots: vscode.Uri[],
    private readonly receive: (data: unknown, origin: 'timeline' | 'preview') => void,
    private readonly model: (webview: vscode.Webview, view: 'timeline' | 'preview', sent?: string) => Model,
    private readonly closed: () => void = () => {}) {
    this.disposables.push(vscode.window.registerWebviewViewProvider('manimCue.timeline', {
      resolveWebviewView: view => {
        this.timeline = view; this.sent = undefined; this.initialize(view.webview, 'timeline');
        view.onDidChangeVisibility(() => { if (view.visible) this.update(); });
        view.onDidDispose(() => { if (this.timeline === view) this.timeline = undefined; });
      },
    }));
  }
  private initialize(webview: vscode.Webview, kind: 'timeline' | 'preview'): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.root, 'dist'), vscode.Uri.joinPath(this.root, 'webview'), ...this.mediaRoots] };
    const nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.root, 'dist', `${kind}.js`));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.root, 'webview', 'styles.css'));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; media-src ${webview.cspSource};"><link rel="stylesheet" href="${style}"><title>Manim Cue</title></head><body><main id="app"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    webview.onDidReceiveMessage(data => this.receive(data, kind));
  }
  get previewOpen(): boolean { return !!this.preview; }
  async open(): Promise<void> {
    if (!this.preview) {
      this.preview = vscode.window.createWebviewPanel('manimCue.preview', 'Manim Cue — Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {});
      const panel = this.preview;
      this.initialize(panel.webview, 'preview');
      panel.onDidDispose(() => { if (this.preview === panel) { this.preview = undefined; this.closed(); } });
      panel.onDidChangeViewState(() => { if (panel.visible) this.update(); });
    } else this.preview.reveal(this.preview.viewColumn, true);
    await vscode.commands.executeCommand('manimCue.timeline.focus');
    this.timeline?.show(true);
    this.update();
  }
  /** A webview script starts: it has no state yet. */
  ready(view: 'timeline' | 'preview'): void { if (view === 'timeline') this.sent = undefined; this.update(); }
  update(): void {
    // Changing resource roots reloads VS Code's webview. Keep the media-only root stable.
    if (this.timeline) {
      const model = this.model(this.timeline.webview, 'timeline', this.sent);
      this.sent = model.timelineId;
      void this.timeline.webview.postMessage({ kind: 'state', model } satisfies HostMessage);
    }
    if (this.preview) void this.preview.webview.postMessage({ kind: 'state', model: this.model(this.preview.webview, 'preview') } satisfies HostMessage);
    this.updated.fire();
  }
  /** The preview moved: show the position on the timeline. */
  position(time: number): void { void this.timeline?.webview.postMessage({ kind: 'position', time } satisfies HostMessage); }
  /** The timeline view chose a time: move the preview there. */
  seek(time: number): void { void this.preview?.webview.postMessage({ kind: 'seek', time } satisfies HostMessage); }
  step(direction: -1 | 1): void { void this.preview?.webview.postMessage({ kind: 'step', direction } satisfies HostMessage); }
  dispose(): void { this.preview?.dispose(); this.disposables.forEach(d => d.dispose()); this.updated.dispose(); }
}
