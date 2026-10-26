import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
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
  /** The editor has the first unsaved change of the scene file since the last update. */
  edited(): void;
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
  private changes = false;
  /** The editor changed the scene file after the last update; a save of the old content still updates. */
  get edited(): boolean { return this.changes; }
  /** The pause after a save, in ms; a test can make it shorter. */
  constructor(private readonly scene: WatchedScene, public delay = 500) {}
  /** An update of this content starts. */
  updating(hash: string): void { this.stop(); this.hash = hash; this.changes = false; }
  /** Another scene file opens. */
  reset(): void { this.stop(); this.hash = undefined; this.changes = false; }
  /** Stops a queued update and drops the notifications on the way. */
  stop(): void { clearTimeout(this.timer); this.timer = undefined; ++this.check; }
  /**
   * The editor changed `uri`. Only the scene file counts: other files count when they are
   * saved. With `text`, the editor is clean again, for example after an undo.
   */
  async edit(uri: FileUri, text?: string): Promise<void> {
    if (uri.toString() !== this.scene.file()?.toString()) return;
    if (!this.changes) { this.changes = true; this.scene.edited(); }
    if (text !== undefined) await this.saved(uri, text);
  }
  /** A file changed on disk, or was deleted. */
  changed(uri: FileUri): void {
    const file = this.scene.file();
    if (!file) return;
    if (uri.toString() === file.toString()) void this.edit(uri);
    else if (!insideEnvironment(uri.fsPath) &&
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
      const bytes = await fs.readFile(uri.fsPath), hash = createHash('sha256').update(bytes).digest('hex');
      if (check !== this.check) return;
      // A disk notification must never run an older saved version under a dirty buffer.
      if (this.scene.dirty(uri)) return;
      // The editor text has no UTF-8 BOM.
      if (text !== undefined && bytes.toString('utf8').replace(/^\uFEFF/u, '') !== text) return;
      // A save and the file watcher often report the same write. Do not cancel a queued
      // or running update for the duplicate, even when the watcher comes late.
      if (hash === this.hash && !this.changes) return;
      this.hash = hash; this.changes = false;
      const automatic = this.scene.automatic(uri);
      this.scene.invalidate(automatic ? 'Update queued…' : 'Outdated. Refresh to update.', hash);
      if (!automatic) return;
      check = this.check;
      this.scene.queued();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        // refresh() stops the watch at once: its errors show unless a later save replaced it.
        const update = this.scene.refresh(), started = this.check;
        update.catch(e => { if (started === this.check) this.scene.failed('Update failed', e); });
      }, this.delay);
    } catch (e) {
      if (check !== this.check) return;
      this.scene.invalidate('Cannot read the scene file. Save it again to update.');
      this.scene.failed('Cannot read the scene file. Save it again to update.', e);
    }
  }
  dispose(): void { this.stop(); }
}
