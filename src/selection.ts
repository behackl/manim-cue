import type { Event } from './timeline';
export type SelectionMode = 'replace' | 'toggle' | 'range';
export type TimeRange = { start: number; end: number };

export function selectEvents(events: Event[], selected: string[], id: string, mode: SelectionMode, anchor?: string): string[] {
  const end = events.findIndex(e => e.id === id);
  if (end < 0) return selected;
  if (mode === 'range') {
    const start = events.findIndex(e => e.id === anchor);
    return events.slice(Math.min(start < 0 ? end : start, end), Math.max(start, end) + 1).map(e => e.id);
  }
  if (mode === 'toggle') {
    const ids = new Set(selected); if (ids.has(id)) ids.delete(id); else ids.add(id);
    return events.filter(e => ids.has(e.id)).map(e => e.id);
  }
  return [id];
}
export function selectionRange(events: Event[], selected: string[]): TimeRange | undefined {
  if (!selected.length) return;
  const ids = new Set(selected), entries = events.filter(e => ids.has(e.id));
  if (!entries.length) return;
  const start = Math.min(...entries.map(e => e.start)), end = Math.max(...entries.map(e => e.end));
  return end > start ? { start, end } : undefined;
}
// Timeline sample boundaries can carry accumulated floating-point roundoff. Only map
// intervals on the known output cadence, then seek using the actual decoded PTS.
export function movieLoop(range: TimeRange, fps: number, pts: number[], duration: number): TimeRange | undefined {
  const first = Math.round(range.start * fps), stop = Math.round(range.end * fps);
  if (first < 0 || stop > pts.length || stop <= first ||
    Math.abs(first / fps - range.start) > 1e-6 || Math.abs(stop / fps - range.end) > 1e-6) return;
  const start = pts[first], end = pts[stop] ?? duration;
  return end > start ? { start, end } : undefined;
}
