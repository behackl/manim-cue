export type PreviewTask = 'frame' | 'timeline' | 'movie';
type Task = { kind: PreviewTask; run: (signal: AbortSignal) => Promise<void>; due: number };
const priority: PreviewTask[] = ['frame', 'timeline', 'movie'];

/** One subprocess task at a time; retain only the latest task of each kind. */
export class PreviewQueue {
  private pending = new Map<PreviewTask, Task>();
  private active?: { task: Task; abort: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private held = false;
  private stopped: Array<() => void> = [];
  private waiters: Array<() => void> = [];
  constructor(private readonly changed: () => void, private readonly failed: (error: unknown) => void) {}
  get busy(): boolean { return !!this.active || this.pending.size > 0; }
  running(kind: PreviewTask): boolean { return this.active?.task.kind === kind && !this.active.abort.signal.aborted; }
  enqueue(kind: PreviewTask, run: Task['run'], delay = 0): void {
    this.pending.set(kind, { kind, run, due: Date.now() + delay });
    const active = this.active;
    if (!this.held && active && !active.abort.signal.aborted && priority.indexOf(kind) <= priority.indexOf(active.task.kind)) {
      if (kind !== active.task.kind && !this.pending.has(active.task.kind)) this.pending.set(active.task.kind, active.task);
      active.abort.abort();
    }
    this.pump(); this.changed();
  }
  remove(kind: PreviewTask): void {
    this.pending.delete(kind);
    if (this.active?.task.kind === kind) this.active.abort.abort();
    this.pump(); this.changed();
  }
  clear(): void {
    this.pending.clear(); this.active?.abort.abort();
    clearTimeout(this.timer); this.timer = undefined;
    this.pump(); this.changed();
  }
  whenIdle(): Promise<void> {
    return this.busy ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve();
  }
  /** Explicit exports hold the serial process slot; preview requests still coalesce. */
  async suspend(): Promise<() => void> {
    if (this.held) throw new Error('A native export is already running.');
    this.held = true; clearTimeout(this.timer);
    const active = this.active;
    if (active && !active.abort.signal.aborted) {
      if (!this.pending.has(active.task.kind)) this.pending.set(active.task.kind, active.task);
      active.abort.abort();
    }
    if (active) await new Promise<void>(resolve => this.stopped.push(resolve));
    this.changed();
    return () => { this.held = false; this.pump(); this.changed(); };
  }
  private pump(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.active) return;
    if (this.held) {
      if (!this.pending.size) this.waiters.splice(0).forEach(resolve => resolve());
      return;
    }
    const task = priority.map(kind => this.pending.get(kind)).find(t => t !== undefined);
    if (!task) { this.waiters.splice(0).forEach(resolve => resolve()); return; }
    if (task.due > Date.now()) { this.timer = setTimeout(() => this.pump(), task.due - Date.now()); return; }
    this.pending.delete(task.kind);
    const active = this.active = { task, abort: new AbortController() };
    void task.run(active.abort.signal).catch(error => { if (!active.abort.signal.aborted) this.failed(error); }).finally(() => {
      this.active = undefined; this.stopped.splice(0).forEach(resolve => resolve()); this.pump(); this.changed();
    });
    this.changed();
  }
}
