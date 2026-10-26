import { isCall, type Entry } from './timeline';
import type { TimeRange } from './selection';

// Plays and waits in a skipped section are not in the video. Cue works in scene time and
// converts at the video element. The parts are on frame boundaries, so a small tolerance
// is enough for rounding errors.
const EPSILON = 1e-7;

/** The scene-time parts that the video leaves out, in order and merged. */
export function skippedParts(entries: Entry[]): TimeRange[] {
  const parts: TimeRange[] = [];
  for (const e of entries) {
    if (!isCall(e) || !e.skipped || e.end <= e.start) continue;
    const last = parts.at(-1);
    if (last && e.start <= last.end + EPSILON) last.end = Math.max(last.end, e.end);
    else parts.push({ start: e.start, end: e.end });
  }
  return parts;
}
export function isSkipped(parts: TimeRange[], time: number): boolean {
  return parts.some(p => time >= p.start - EPSILON && time < p.end - EPSILON);
}
/** Video time of a scene time. A time in a skipped part maps to the video time after it. */
export function videoTime(parts: TimeRange[], time: number): number {
  let removed = 0;
  for (const p of parts) {
    if (time < p.start - EPSILON) break;
    removed += Math.min(time, p.end) - p.start;
  }
  return time - removed;
}
/** Scene time of a video time. At the end of a skipped part, the video continues after it. */
export function sceneTime(parts: TimeRange[], time: number): number {
  let scene = time;
  for (const p of parts) if (p.start <= scene + EPSILON) scene += p.end - p.start;
  return scene;
}
