import { isCall, type Entry } from './timeline';
import { videoTime } from './video-time';
export type SelectionMode = 'replace' | 'toggle' | 'range';
export type TimeRange = { start: number; end: number };

/** Selects play and wait entries by their index in the timeline. */
export function selectEvents(entries: Entry[], selected: number[], index: number, mode: SelectionMode, anchor?: number): number[] {
  if (!isCall(entries[index])) return selected;
  const calls = (from: number, to: number) => entries.map((_, i) => i).filter(i => i >= from && i <= to && isCall(entries[i]));
  if (mode === 'range') {
    const start = anchor !== undefined && isCall(entries[anchor]) ? anchor : index;
    return calls(Math.min(start, index), Math.max(start, index));
  }
  if (mode === 'toggle') {
    const ids = new Set(selected); if (ids.has(index)) ids.delete(index); else ids.add(index);
    return calls(0, entries.length).filter(i => ids.has(i));
  }
  return [index];
}
export function selectionRange(entries: Entry[], selected: number[]): TimeRange | undefined {
  const calls = selected.map(i => entries[i]).filter(isCall);
  if (!calls.length) return;
  const start = Math.min(...calls.map(e => e.start)), end = Math.max(...calls.map(e => e.end));
  return end > start ? { start, end } : undefined;
}
/**
 * The loop range in scene time, on frame boundaries. Entry boundaries can carry
 * floating-point roundoff. A range in skipped parts only has no video to loop.
 */
export function videoLoop(range: TimeRange, fps: number, frames: number, skipped: TimeRange[]): TimeRange | undefined {
  const first = Math.round(range.start * fps), stop = Math.round(range.end * fps);
  if (first < 0 || stop > frames || stop <= first ||
    Math.abs(first / fps - range.start) > 1e-6 || Math.abs(stop / fps - range.end) > 1e-6) return;
  const loop = { start: first / fps, end: stop / fps };
  return videoTime(skipped, loop.end) - videoTime(skipped, loop.start) > 1e-6 ? loop : undefined;
}
