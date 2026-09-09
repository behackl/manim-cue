// Half-open frame intervals; compare boundaries directly (n / fps * fps can round down).
export function indexAt(time: number, count: number, boundary: (index: number) => number): number {
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (boundary(mid) <= time) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, Math.min(count - 1, lo - 1));
}
export function frameIndex(time: number, fps: number, count = Number.MAX_SAFE_INTEGER): number {
  return indexAt(time, count, index => index / fps);
}
