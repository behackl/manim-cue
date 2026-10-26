// Half-open frame intervals; compare boundaries directly (n / fps * fps can round down).
export function frameIndex(time: number, fps: number, count = Number.MAX_SAFE_INTEGER): number {
  let lo = 0, hi = count;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (mid / fps <= time) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, Math.min(count - 1, lo - 1));
}
/**
 * The frame that a video shows at a time reported by the video element. Such a time is
 * a frame timestamp with a small rounding error in the file, or a seek target in the
 * middle of a frame.
 */
export function videoFrameIndex(time: number, fps: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor(time * fps + .25)));
}
export function videoFrames(duration: number, fps: number): number { return Math.round(duration * fps); }
