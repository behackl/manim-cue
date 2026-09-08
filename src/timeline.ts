// Public experimental Manim v1 observations. Never reinterpret samples as video frames.
export interface Site {
  path: string | null;
  line: number;
  coverage: string;
  outside_root: boolean;
  site_id: string | null;
  occurrence: number | null;
  display_name?: string;
}
export interface Event {
  id: string; ordinal: number; order: number; kind: 'play' | 'wait';
  start: number; end: number; nominal_duration: number;
  samples: number; hold_intervals: number;
  animations: { type: string; run_time: number }[];
  source: Site | null;
}
interface DeclarationBase {
  order: number; at: number; event_boundary: number; event_id: string | null;
  source: Site | null;
}
export type Declaration = DeclarationBase & (
  | { kind: 'section'; name: string; type: string; skip_requested: boolean }
  | { kind: 'caption'; content: string; start: number; end: number }
  | { kind: 'sound'; start: number; duration: number | null; gain: number | null;
      asset: { request?: string; path?: string | null; display_name?: string; resolution: string }; options: Record<string, unknown> }
);
export interface Timeline {
  schema: 'manim.execution-timeline'; version: 1; complete: true;
  policy: 'no-raster-full'; revision: string; termination: string;
  scene: { name: string }; backend: string; frame_rate: number; start: number; end: number;
  source: { path: string | null; sha256: string | null; provenance: string; coverage: string };
  events: Event[]; declarations: Declaration[];
}
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const hash = /^[a-f0-9]{64}$/;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid timeline: ${message}`);
}
function object(x: unknown): asserts x is Record<string, unknown> {
  assert(x !== null && typeof x === 'object' && !Array.isArray(x), 'expected object');
}
function text(x: unknown): asserts x is string { assert(typeof x === 'string', 'expected string'); }
function finite(x: unknown): asserts x is number { assert(typeof x === 'number' && Number.isFinite(x), 'non-finite time/value'); }
function natural(x: unknown): asserts x is number { assert(Number.isSafeInteger(x) && (x as number) >= 0, 'invalid count/order'); }
export function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') &&
    !path.includes(':') && !path.includes('\0') && !path.split('/').some(p => p === '..' || p === '.' || !p);
}
function site(x: unknown): void {
  if (x === null) return;
  object(x); text(x.coverage); natural(x.line); assert(x.line > 0, 'source line must be one-based');
  assert(typeof x.outside_root === 'boolean', 'missing source coverage');
  if (x.path !== null) { text(x.path); assert(safeRelativePath(x.path), 'unsafe source path'); }
  assert(!x.outside_root || x.path === null, 'outside-root path must be redacted');
  assert(x.site_id === null || (typeof x.site_id === 'string' && hash.test(x.site_id)), 'invalid site ID');
  if (x.occurrence !== null) natural(x.occurrence);
}
export function parseTimeline(json: string): Timeline {
  assert(json.length <= MAX_REPORT_BYTES, 'report too large');
  const t: unknown = JSON.parse(json); object(t);
  assert(t.schema === 'manim.execution-timeline' && t.version === 1, 'unsupported schema/version');
  assert(t.complete === true && t.policy === 'no-raster-full', 'unsupported or incomplete policy');
  assert(typeof t.revision === 'string' && hash.test(t.revision), 'invalid revision');
  assert(t.termination === 'completed' || t.termination === 'scene-end-request', 'unknown termination');
  object(t.scene); text(t.scene.name); text(t.backend);
  finite(t.frame_rate); assert(t.frame_rate > 0, 'invalid evaluation rate');
  finite(t.start); finite(t.end); assert(t.end >= t.start && Number.isFinite(t.end - t.start), 'invalid scene span');
  object(t.source); text(t.source.provenance); text(t.source.coverage);
  assert(t.source.sha256 === null || (typeof t.source.sha256 === 'string' && hash.test(t.source.sha256)), 'invalid source hash');
  if (t.source.path !== null) { text(t.source.path); assert(safeRelativePath(t.source.path), 'unsafe primary path'); }
  assert(Array.isArray(t.events) && t.events.length <= 20000, 'missing/oversized events');
  assert(Array.isArray(t.declarations) && t.declarations.length <= 20000, 'missing/oversized declarations');
  const ids = new Set<string>(); const orders = new Set<number>();
  let end = t.start; let ordinal = -1; let order = -1;
  for (const e of t.events) {
    object(e); text(e.id); assert(e.id.length > 0 && !ids.has(e.id), 'duplicate event ID'); ids.add(e.id);
    natural(e.ordinal); natural(e.order);
    assert(e.ordinal > ordinal && e.order > order, 'events out of order'); ordinal = e.ordinal; order = e.order;
    orders.add(e.order);
    assert(e.kind === 'play' || e.kind === 'wait', 'unknown event kind');
    finite(e.start); finite(e.end); finite(e.nominal_duration);
    assert(e.start >= end && e.end >= e.start && e.end <= t.end && e.nominal_duration >= 0, 'invalid event span');
    end = e.end; natural(e.samples); natural(e.hold_intervals); site(e.source);
    assert(Array.isArray(e.animations), 'missing animation summaries');
    for (const a of e.animations) { object(a); text(a.type); finite(a.run_time); assert(a.run_time >= 0, 'negative animation duration'); }
  }
  order = -1;
  let at = t.start;
  for (const d of t.declarations) {
    object(d); natural(d.order); finite(d.at); natural(d.event_boundary); site(d.source);
    assert(d.at >= at && d.at <= t.end, 'declarations out of reached-time order'); at = d.at;
    assert(d.order > order && !orders.has(d.order), 'duplicate/unordered declaration'); order = d.order; orders.add(d.order);
    assert(d.event_id === null || (typeof d.event_id === 'string' && ids.has(d.event_id)), 'unknown declaration event');
    if (d.kind === 'section') { text(d.name); text(d.type); assert(typeof d.skip_requested === 'boolean', 'missing skip intent'); }
    else if (d.kind === 'caption') { text(d.content); finite(d.start); finite(d.end); assert(d.end >= d.start, 'invalid caption interval'); }
    else if (d.kind === 'sound') {
      finite(d.start); if (d.duration !== null) { finite(d.duration); assert(d.duration >= 0, 'negative sound duration'); }
      if (d.gain !== null) finite(d.gain);
      object(d.asset); text(d.asset.resolution);
      for (const key of ['request', 'path', 'display_name']) if (d.asset[key] != null) text(d.asset[key]);
      object(d.options);
    } else throw new Error('Invalid timeline: unknown declaration kind');
  }
  const [lo, hi] = extent(t as unknown as Timeline);
  assert(Number.isFinite(hi - lo), 'annotation extent is not representable');
  // Integrity verification is performed on original JSON in Python. JS stringify loses 4.0 vs 4.
  return t as unknown as Timeline;
}
export function extent(t: Timeline): [number, number] {
  let lo = Math.min(0, t.start), hi = t.end;
  for (const d of t.declarations) {
    if (d.kind === 'section') continue;
    lo = Math.min(lo, d.start);
    hi = Math.max(hi, d.kind === 'caption' ? d.end : d.start + (d.duration ?? 0));
  }
  return [lo, Math.max(hi, lo + 0.1)];
}
export function soundLabel(d: Extract<Declaration, {kind: 'sound'}>): string {
  return d.asset.request ?? d.asset.path ?? d.asset.display_name ?? 'Unknown sound';
}
export function pairingReason(t: Timeline, videoDuration: number, videoRate: number, maxFrameTimeError: number): string | null {
  if (!Number.isFinite(videoDuration) || videoDuration <= 0 || !Number.isFinite(videoRate) || videoRate <= 0) return 'No valid video time axis';
  if (Math.abs(videoRate - t.frame_rate) > 1e-6) return `Video and evaluation rates differ (${videoRate} vs ${t.frame_rate} fps)`;
  if (!Number.isFinite(maxFrameTimeError) || maxFrameTimeError < 0) return 'No measured video frame timing';
  if (maxFrameTimeError > 0.5 / videoRate + 1e-6) return 'Video timestamps drift from the evaluation frame cadence';
  if (t.start !== 0) return 'Nonzero logical origin';
  if (t.declarations.some(d => d.kind === 'section' && d.skip_requested)) return 'Render can skip sections that evaluation included';
  let end = 0;
  for (const e of t.events) { if (Math.abs(e.start - end) > 1e-7) return 'Logical gaps have no measured video mapping'; end = e.end; }
  if (Math.abs(end - t.end) > 1e-7) return 'Time advanced outside recorded events';
  if (Math.abs(videoDuration - t.end) > 0.5 / videoRate + 1e-6) return 'Video and observed timeline durations differ';
  return null; // Plausibility only, NEVER verified correspondence.
}
