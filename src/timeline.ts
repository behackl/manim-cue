// Manim's experimental timeline format `manim.timeline` version 1.
export interface Source { path: string | null; line: number }
interface Base { start: number; source: Source | null }
export interface Call extends Base {
  kind: 'play' | 'wait'; end: number; run_time: number; frozen: boolean; skipped: boolean;
  animations: { type: string; run_time: number }[];
}
export interface Section extends Base { kind: 'section'; name: string; type: string; skip_animations: boolean }
export interface Caption extends Base { kind: 'caption'; end: number; content: string }
export interface Sound extends Base {
  kind: 'sound'; file: string; duration: number | null; gain: number | null; gain_to_background: number | null;
}
export type Entry = Call | Section | Caption | Sound;
export interface Timeline {
  schema: 'manim.timeline'; version: 1; mode: 'evaluate' | 'render';
  scene: string; backend: string; frame_rate: number; duration: number; ended_early: boolean;
  source: { path: string; sha256: string } | null;
  entries: Entry[];
}

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid timeline: ${message}`);
}
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isText = (x: unknown): x is string => typeof x === 'string';
const optional = (x: unknown, check: (x: unknown) => boolean) => x === null || check(x);

const fields: Record<Entry['kind'], (e: Record<string, unknown>) => boolean> = {
  play: e => call(e), wait: e => call(e),
  section: e => isText(e.name) && isText(e.type) && typeof e.skip_animations === 'boolean',
  caption: e => isNumber(e.end) && isText(e.content),
  sound: e => isText(e.file) && optional(e.duration, isNumber) && optional(e.gain, isNumber) && optional(e.gain_to_background, isNumber),
};
function call(e: Record<string, unknown>): boolean {
  return isNumber(e.end) && isNumber(e.run_time) && typeof e.frozen === 'boolean' && typeof e.skipped === 'boolean' &&
    Array.isArray(e.animations) && e.animations.every(a => isObject(a) && isText(a.type) && isNumber(a.run_time));
}

/** Checks the schema, the version and the shape of the entries. */
export function parseTimeline(json: string): Timeline {
  const t: unknown = JSON.parse(json);
  assert(isObject(t) && t.schema === 'manim.timeline' && t.version === 1, 'unsupported schema or version');
  assert((t.mode === 'evaluate' || t.mode === 'render') && isText(t.scene) && isText(t.backend) &&
    isNumber(t.frame_rate) && t.frame_rate > 0 && isNumber(t.duration) && t.duration >= 0 && typeof t.ended_early === 'boolean', 'invalid header');
  assert(t.source === null || isObject(t.source) && isText(t.source.path) && isText(t.source.sha256), 'invalid source');
  assert(Array.isArray(t.entries), 'missing entries');
  for (const e of t.entries) {
    assert(isObject(e) && Object.hasOwn(fields, e.kind as string) && isNumber(e.start), 'invalid entry');
    assert(e.source === null || isObject(e.source) && optional(e.source.path, isText) && Number.isSafeInteger(e.source.line), 'invalid entry source');
    assert(fields[e.kind as Entry['kind']](e), `invalid ${e.kind} entry`);
  }
  return t as unknown as Timeline;
}
export function isCall(entry: Entry | undefined): entry is Call { return entry?.kind === 'play' || entry?.kind === 'wait'; }
/** Time span to draw: captions and sounds can start before zero or end after the scene. */
export function extent(t: Timeline): [number, number] {
  let lo = 0, hi = t.duration;
  for (const e of t.entries) {
    if (e.kind === 'caption') { lo = Math.min(lo, e.start); hi = Math.max(hi, e.end); }
    if (e.kind === 'sound') { lo = Math.min(lo, e.start); hi = Math.max(hi, e.start + (e.duration ?? 0)); }
  }
  return [lo, Math.max(hi, lo + 0.1)];
}
