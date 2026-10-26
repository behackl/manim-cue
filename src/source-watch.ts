import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileHash } from './jobs';
import { insideEnvironment } from './setup-plan';

/** The parts of a `vscode.Uri` that SourceWatch uses. */
export interface FileUri { fsPath: string; toString(): string }
export interface WatchedScene {
  file(): FileUri | undefined;
  /** An open editor has unsaved changes of the file. */
  dirty(uri: FileUri): boolean;
  /** A save starts an update: the workspace is trusted and "Auto Refresh On Save" is on. */
  automatic(uri: FileUri): boolean;
  invalidate(reason: string, savedHash?: string): void;
  /** A save starts an update after a short pause. */
  queued(): void;
  refresh(): Promise<void>;
  failed(status: string, error: unknown): void;
}

/** Decides when a change of the scene file or of a project file makes the results outdated, and when a save updates them. */
export class SourceWatch {
  private timer?: ReturnType<typeof setTimeout>;
  /** Increments to drop the notifications and the queued update that came before. */
  private check = 0;
  /** The content of the last update. */
  private hash?: string;
  /** The editor changed the scene file after the last update; a save of the old content still updates. */
  private edited = false;
  constructor(private readonly scene: WatchedScene, private readonly delay = 500) {}
  /** An update of this content starts. */
  updating(hash: string): void { this.stop(); this.hash = hash; this.edited = false; }
  /** Another scene file opens. */
  reset(): void { this.stop(); this.hash = undefined; this.edited = false; }
  /** Stops a queued update. */
  stop(): void { clearTimeout(this.timer); this.timer = undefined; ++this.check; }
  changed(uri: FileUri): void {
    const file = this.scene.file();
    if (!file) return;
    if (uri.toString() === file.toString()) {
      this.edited = true;
      this.scene.invalidate('Outdated. Save the scene file to update.');
    } else if (!insideEnvironment(uri.fsPath) &&
      (uri.fsPath.endsWith('.py') || uri.fsPath.endsWith('manim.cfg') || path.basename(uri.fsPath) === '.env')) {
      this.scene.invalidate('Outdated. A project file changed. Refresh to update.');
    }
  }
  /**
   * The file `uri` is saved. With `text`, an edit made the editor clean: VS Code can report
   * that before its dirty state is right, so only an edit back to the saved content counts.
   */
  async saved(uri: FileUri, text?: string): Promise<void> {
    if (uri.toString() !== this.scene.file()?.toString()) { this.changed(uri); return; }
    let check = ++this.check;
    try {
      const hash = await fileHash(uri.fsPath);
      if (check !== this.check) return;
      // A disk notification must never run an older saved version under a dirty buffer.
      if (this.scene.dirty(uri)) return;
      if (text !== undefined && createHash('sha256').update(text).digest('hex') !== hash) return;
      // A save and the file watcher often report the same write. Do not cancel a queued
      // or running update for the duplicate, even when the watcher comes late.
      if (hash === this.hash && !this.edited) return;
      this.hash = hash; this.edited = false;
      const automatic = this.scene.automatic(uri);
      this.scene.invalidate(automatic ? 'Update queued…' : 'Outdated. Refresh to update.', hash);
      if (!automatic) return;
      check = this.check;
      this.scene.queued();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        // The update stops this check only after its first checks; their errors show here.
        void this.scene.refresh().catch(e => { if (check === this.check) this.scene.failed('Update failed', e); });
      }, this.delay);
    } catch (e) {
      if (check !== this.check) return;
      this.scene.invalidate('Cannot read the scene file. Save it again to update.');
      this.scene.failed('Cannot read the scene file. Save it again to update.', e);
    }
  }
  dispose(): void { this.stop(); }
}
