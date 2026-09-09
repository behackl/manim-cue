import { contain, coordinate, rulerTicks, scenePoint, validSize, type Point, type Rect, type Size } from '../src/measurement';
import { button, el, post, saved, save } from './shared';
const ns = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
type Target = { element: HTMLVideoElement | HTMLImageElement; token: string; frame: Size };
export class Measurement {
  enabled = (saved() as { measure?: boolean } | undefined)?.measure === true;
  private target?: Target;
  private rect?: Rect;
  private cursor?: Point;
  private anchor?: Point;
  private end?: Point;
  private drag?: number;
  private layer = svg('svg', { class: 'measure-layer' });
  private ink = svg('g');
  private hit = svg('rect', { class: 'measure-surface', fill: 'transparent', tabindex: 0, 'aria-label': 'Measure scene coordinates. Click to pin, drag to measure, Escape to clear.' });
  private bar = el('div', 'measure-bar');
  private info = el('span', 'measure-assumption');
  private readout = el('output', 'measure-readout');
  private toggle: HTMLButtonElement;
  private copy = button('Copy point', () => {
    const p = this.end ?? this.anchor ?? this.cursor;
    if (p && this.target) post({ kind: 'copyPoint', token: this.target.token, ...p });
  }, 'Copy pinned point or drag endpoint (otherwise pointer) as [x, y, 0], rounded to six significant digits');
  constructor(private stage: HTMLElement, controls: HTMLElement, private changed: () => void) {
    this.toggle = button('Measure', () => this.setEnabled(!this.enabled), 'Use configured dimensions, assuming a fixed, centred, unrotated 2D camera. Pauses playback; no camera tracking.');
    this.toggle.classList.add('measure-toggle');
    this.toggle.setAttribute('aria-pressed', String(this.enabled)); controls.append(this.toggle);
    stage.classList.toggle('measuring', this.enabled);
    this.bar.append(this.info, this.readout, this.copy, button('Clear', () => { this.clear(); this.draw(); }));
    this.bar.hidden = !this.enabled; controls.after(this.bar);
    this.layer.append(this.hit, this.ink); this.layer.setAttribute('hidden', ''); stage.append(this.layer);
    const observer = new ResizeObserver(() => this.draw()); observer.observe(stage);
    this.hit.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const p = this.point(event); if (!p) return;
      event.preventDefault(); this.hit.focus(); this.hit.setPointerCapture(event.pointerId);
      this.drag = event.pointerId; this.anchor = this.cursor = p; this.end = undefined; this.draw();
    });
    this.hit.addEventListener('pointermove', event => {
      if (this.drag !== undefined && event.pointerId !== this.drag) return;
      this.cursor = this.point(event, this.drag !== undefined);
      if (this.drag !== undefined) this.end = this.cursor;
      this.draw();
    });
    this.hit.addEventListener('pointerup', event => {
      if (this.drag !== event.pointerId) return;
      this.end = this.point(event, true); this.release(); this.draw();
    });
    this.hit.addEventListener('pointercancel', () => { this.clear(); this.draw(); });
    this.hit.addEventListener('lostpointercapture', event => { if (this.drag === event.pointerId) { this.drag = undefined; this.draw(); } });
    this.hit.addEventListener('pointerleave', () => { if (this.drag === undefined) { this.cursor = undefined; this.draw(); } });
    this.hit.addEventListener('keydown', event => { if (event.key === 'Escape') { this.clear(); this.draw(); } });
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled; save({ measure: enabled }); this.toggle.setAttribute('aria-pressed', String(enabled));
    this.bar.hidden = !enabled; this.stage.classList.toggle('measuring', enabled);
    if (!enabled) this.clear();
    this.changed(); this.draw();
  }
  setTarget(target?: Target): void {
    if (target && !validSize(target.frame)) target = undefined;
    if (this.target?.token !== target?.token) this.clear();
    this.target = target;
    if (this.enabled && target?.element instanceof HTMLVideoElement) target.element.pause();
    this.draw();
  }
  private release(): void {
    if (this.drag !== undefined && this.hit.hasPointerCapture(this.drag)) this.hit.releasePointerCapture(this.drag);
    this.drag = undefined;
  }
  private clear(): void { this.release(); this.anchor = this.end = this.cursor = undefined; }
  private point(event: PointerEvent, clamp = false): Point | undefined {
    if (!this.rect || !this.target) return;
    const stage = this.stage.getBoundingClientRect();
    return scenePoint({ x: event.clientX - stage.left, y: event.clientY - stage.top }, this.rect, this.target.frame, clamp);
  }
  private draw(): void {
    this.layer.toggleAttribute('hidden', !this.enabled || !this.target);
    this.copy.disabled = !this.target || !(this.end ?? this.anchor ?? this.cursor);
    if (!this.enabled) return;
    if (!this.target) {
      this.info.textContent = 'Fixed-camera 2D · waiting for a current, decoded preview'; this.readout.textContent = ''; return;
    }
    const { element, frame } = this.target;
    this.info.textContent = `Fixed-camera 2D · configured ${coordinate(frame.width)} × ${coordinate(frame.height)} units · assumes centred, unrotated camera`;
    const bounds = element.getBoundingClientRect(), stage = this.stage.getBoundingClientRect();
    const intrinsic = element instanceof HTMLVideoElement
      ? { width: element.videoWidth, height: element.videoHeight } : { width: element.naturalWidth, height: element.naturalHeight };
    this.rect = contain({ x: bounds.left - stage.left, y: bounds.top - stage.top, width: bounds.width, height: bounds.height }, intrinsic);
    if (!this.rect) { this.layer.setAttribute('hidden', ''); return; }
    const r = this.rect;
    this.layer.setAttribute('viewBox', `0 0 ${stage.width} ${stage.height}`);
    for (const [key, value] of Object.entries(r)) this.hit.setAttribute(key, String(value));
    this.ink.replaceChildren();
    const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => this.ink.append(svg('line', { x1, y1, x2, y2, class: cls }));
    const label = (x: number, y: number, text: string, anchor = 'middle') => {
      const node = svg('text', { x, y, 'text-anchor': anchor }); node.textContent = text; this.ink.append(node);
    };
    const px = (x: number) => r.x + (x / frame.width + .5) * r.width;
    const py = (y: number) => r.y + (.5 - y / frame.height) * r.height;
    line(r.x, r.y - 1, r.x + r.width, r.y - 1, 'ruler');
    line(r.x - 1, r.y, r.x - 1, r.y + r.height, 'ruler');
    for (const x of rulerTicks(frame.width, r.width)) {
      line(px(x), r.y - 5, px(x), r.y, 'ruler'); label(px(x), r.y - 9, coordinate(x));
    }
    for (const y of rulerTicks(frame.height, r.height)) {
      line(r.x - 5, py(y), r.x, py(y), 'ruler'); label(r.x - 8, py(y) + 3, coordinate(y), 'end');
    }
    const p = this.end ?? this.anchor ?? this.cursor;
    if (this.cursor) {
      line(px(this.cursor.x), r.y, px(this.cursor.x), r.y + r.height, 'measure-crosshair');
      line(r.x, py(this.cursor.y), r.x + r.width, py(this.cursor.y), 'measure-crosshair');
    }
    if (this.anchor) this.ink.append(svg('circle', { cx: px(this.anchor.x), cy: py(this.anchor.y), r: 4, class: 'measure-pin' }));
    this.readout.textContent = p ? `(${coordinate(p.x)}, ${coordinate(p.y)})` : 'Move to inspect · click to pin · drag to measure';
    if (this.cursor && this.anchor && (this.cursor.x !== p?.x || this.cursor.y !== p?.y)) {
      this.readout.textContent += ` · pointer (${coordinate(this.cursor.x)}, ${coordinate(this.cursor.y)})`;
    }
    if (this.anchor && this.end) {
      const dx = this.end.x - this.anchor.x, dy = this.end.y - this.anchor.y;
      line(px(this.anchor.x), py(this.anchor.y), px(this.end.x), py(this.end.y), 'measure-distance');
      this.ink.append(svg('circle', { cx: px(this.end.x), cy: py(this.end.y), r: 3, class: 'measure-pin' }));
      this.readout.textContent += ` · Δx ${coordinate(dx)} · Δy ${coordinate(dy)} · distance ${coordinate(Math.hypot(dx, dy))}`;
    }
  }
}
