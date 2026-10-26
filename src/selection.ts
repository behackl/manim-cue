import { isCall, type Entry } from './timeline';
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
// Entry boundaries can carry floating-point roundoff. Only map intervals on the
// frame cadence of the video.
export function movieLoop(range: TimeRange, fps: number, frames: number): TimeRange | undefined {
  const first = Math.round(range.start * fps), stop = Math.round(range.end * fps);
  if (first < 0 || stop > frames || stop <= first ||
    Math.abs(first / fps - range.start) > 1e-6 || Math.abs(stop / fps - range.end) > 1e-6) return;
  return { start: first / fps, end: stop / fps };
}
