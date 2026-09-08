// Configured, centred, unrotated 2D reference coordinates — not camera tracking.
export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }
export interface Point { x: number; y: number }
export function validSize(size?: Size): size is Size {
  return !!size && [size.width, size.height].every(n => Number.isFinite(n) && n > 0);
}
export function contain(box: Rect, intrinsic: Size): Rect | undefined {
  if (!validSize(box) || !validSize(intrinsic)) return;
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  const width = intrinsic.width * scale, height = intrinsic.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}
export function scenePoint(point: Point, rect: Rect, frame: Size, clamp = false): Point | undefined {
  if (!validSize(rect) || !validSize(frame) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  let u = (point.x - rect.x) / rect.width, v = (point.y - rect.y) / rect.height;
  if (!clamp && (u < 0 || u > 1 || v < 0 || v > 1)) return;
  u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1, v));
  return { x: (u - .5) * frame.width, y: (.5 - v) * frame.height };
}
export function rulerTicks(span: number, pixels: number): number[] {
  if (!(span > 0) || !Number.isFinite(span) || !(pixels > 0) || !Number.isFinite(pixels)) return [];
  const wanted = span / Math.max(1, Math.min(50, pixels / 65));
  const magnitude = 10 ** Math.floor(Math.log10(wanted));
  const step = ([1, 2, 5, 10].find(n => n * magnitude >= wanted) ?? 10) * magnitude;
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const ticks: number[] = [];
  for (let i = Math.ceil(-span / 2 / step); i <= Math.floor(span / 2 / step) && ticks.length < 100; i++) ticks.push(i * step);
  return ticks;
}
export const coordinate = (value: number): string => String(Number(value.toPrecision(6)));
