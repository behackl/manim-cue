import type { FrameMedia, VideoMedia } from '../src/protocol';
import { contain } from '../src/measurement';
import { button, el, post, saved, save } from './shared';

/** What the preview shows; `current` is false while it waits for a newer result. */
export type Shown = { element: HTMLImageElement | HTMLVideoElement; media: FrameMedia | VideoMedia; current: boolean };

/** Shows the shown frame against a reference frame. The host keeps the reference file. */
export class Comparison {
  enabled = (saved() as { compare?: boolean } | undefined)?.compare === true;
  private shown?: Shown;
  private referenceMedia?: FrameMedia;
  private reference?: { image: HTMLImageElement; media: FrameMedia };
  private loading?: { image: HTMLImageElement; media: FrameMedia };
  private failed?: string;
  /** Pin the next current frame: comparison started from a video. */
  private pinWanted = false;
  private mode: 'wipe' | 'overlay' = (saved() as { compareMode?: string } | undefined)?.compareMode === 'overlay' ? 'overlay' : 'wipe';
  private wipeValue = 50;
  private overlayValue = 50;
  private toggle: HTMLButtonElement;
  private bar = el('div', 'compare-bar');
  private labels = el('div', 'compare-labels');
  private info = el('div', 'compare-info');
  private slider = el('input', 'compare-slider');
  private value = el('output', 'compare-value');
  private wipe = button('Wipe', () => this.setMode('wipe'), 'The reference on the left, the current frame on the right');
  private overlay = button('Overlay', () => this.setMode('overlay'), 'Blend the reference and the current frame');
  private replace = button('Replace reference', () => this.request(true, true), 'Use the shown frame as the reference');
  private canvas = el('canvas', 'compare-canvas');
  private composite = document.createElement('canvas');
  private divider = el('div', 'compare-divider');
  private rect?: { x: number; y: number; width: number; height: number };
  constructor(private stage: HTMLElement, controls: HTMLElement, private changed: (enabled: boolean) => void) {
    this.toggle = button('Compare', () => this.request(!this.enabled, false), 'Keep this frame as the reference and compare other frames with it');
    this.toggle.setAttribute('aria-pressed', 'false'); controls.append(this.toggle);
    this.slider.type = 'range'; this.slider.min = '0'; this.slider.max = '100'; this.slider.step = '1';
    this.slider.addEventListener('input', () => this.setValue(this.slider.valueAsNumber));
    this.bar.append(this.wipe, this.overlay, this.slider, this.value, this.replace, this.labels, this.info);
    this.bar.hidden = true; controls.after(this.bar);
    this.canvas.hidden = true; this.canvas.setAttribute('aria-hidden', 'true');
    this.divider.hidden = true; this.divider.tabIndex = 0; this.divider.setAttribute('role', 'slider');
    this.divider.setAttribute('aria-label', 'Wipe divider'); this.divider.setAttribute('aria-valuemin', '0'); this.divider.setAttribute('aria-valuemax', '100');
    stage.append(this.canvas, this.divider);
    this.divider.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); this.divider.focus(); this.divider.setPointerCapture(e.pointerId); this.drag(e);
    });
    this.divider.addEventListener('pointermove', e => { if (this.divider.hasPointerCapture(e.pointerId)) this.drag(e); });
    this.divider.addEventListener('pointerup', e => { if (this.divider.hasPointerCapture(e.pointerId)) this.divider.releasePointerCapture(e.pointerId); });
    this.divider.addEventListener('keydown', e => {
      const value = this.wipeValue;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 100 : e.key === 'ArrowLeft' ? value - 1 : e.key === 'ArrowRight' ? value + 1 : undefined;
      if (next !== undefined) { e.preventDefault(); e.stopPropagation(); this.setValue(next); }
    });
    new ResizeObserver(() => this.draw()).observe(stage);
  }
  private request(enabled: boolean, replace: boolean): void {
    this.enabled = enabled; this.pinWanted = false; save({ compare: enabled });
    if (enabled && (replace || !this.referenceMedia)) {
      const shown = this.shown;
      // A shown frame is the reference, also when it is outdated. A video gets a new frame first.
      if (shown?.element instanceof HTMLImageElement) { this.failed = undefined; post({ kind: 'pin', id: shown.media.id }); } else this.pinWanted = true;
    }
    this.changed(enabled); this.draw();
  }
  disable(): void { if (this.enabled) this.request(false, false); }
  update(reference: FrameMedia | undefined, shown: Shown | undefined): void {
    this.referenceMedia = reference; this.shown = shown;
    if (this.pinWanted && shown?.element instanceof HTMLImageElement && shown.current) {
      this.pinWanted = false; post({ kind: 'pin', id: shown.media.id });
    }
    this.toggle.setAttribute('aria-pressed', String(this.enabled)); this.bar.hidden = !this.enabled;
    this.toggle.disabled = !this.enabled && !shown;
    this.replace.disabled = !shown || this.pinWanted;
    this.replace.textContent = reference ? 'Replace reference' : 'Pin reference';
    if (!reference) {
      this.loading = this.reference = this.failed = undefined;
    } else if (reference.id !== this.reference?.media.id && reference.id !== this.loading?.media.id && reference.id !== this.failed) {
      const image = new Image(), candidate = this.loading = { image, media: reference };
      const fail = () => { if (this.loading === candidate) { this.loading = undefined; this.failed = reference.id; this.draw(); } };
      image.onload = () => { void image.decode().then(() => {
        if (this.loading !== candidate) return;
        this.reference = candidate; this.loading = undefined; this.draw();
      }).catch(fail); };
      image.onerror = fail; image.src = reference.uri;
    }
    this.draw();
  }
  private setMode(mode: 'wipe' | 'overlay'): void { this.mode = mode; save({ compareMode: mode }); this.draw(); }
  private setValue(value: number): void {
    value = Math.max(0, Math.min(100, value));
    if (this.mode === 'wipe') this.wipeValue = value; else this.overlayValue = value;
    this.draw();
  }
  private drag(e: PointerEvent): void {
    if (!this.rect) return;
    this.setValue((e.clientX - this.stage.getBoundingClientRect().left - this.rect.x) / this.rect.width * 100);
  }
  private label(name: string, media?: FrameMedia | VideoMedia): string {
    if (!media) return `${name}: —`;
    if (!('requestedTime' in media)) return `${name}: video`;
    return `${name}: ${media.time === null ? 'last frame' : media.time.toFixed(2) + ' s'}`;
  }
  private draw(): void {
    this.wipe.setAttribute('aria-pressed', String(this.mode === 'wipe')); this.overlay.setAttribute('aria-pressed', String(this.mode === 'overlay'));
    const value = this.mode === 'wipe' ? this.wipeValue : this.overlayValue;
    this.slider.value = String(value); this.slider.setAttribute('aria-label', this.mode === 'wipe' ? 'Wipe position' : 'Current frame opacity');
    this.slider.setAttribute('aria-valuetext', this.mode === 'wipe' ? `${Math.round(value)}% reference` : `${Math.round(value)}% current frame`);
    this.value.textContent = `${Math.round(value)}% ${this.mode === 'wipe' ? 'reference' : 'current'}`;
    this.divider.setAttribute('aria-valuenow', String(Math.round(this.wipeValue)));
    this.rect = undefined;
    if (!this.enabled) { this.canvas.hidden = this.divider.hidden = true; return; }
    let visible = false;
    const shown = this.shown, reference = this.reference;
    const current = shown?.element instanceof HTMLImageElement ? shown : undefined;
    this.labels.textContent = `${this.label('Reference', reference?.media)}  |  ${this.label('Current', shown?.media)}${shown?.media.outdated ? ' · Outdated' : shown && !shown.current ? ' · Updating' : ''}`;
    const notes: string[] = [];
    if (this.pinWanted) notes.push('Updating frame…');
    else if (this.loading) notes.push('Loading the reference…');
    else if (this.failed) notes.push('The reference did not load. Use “Replace reference” to try again.');
    else if (!reference) notes.push('No reference. Use “Pin reference”.');
    if (current && reference) {
      const a = current.element as HTMLImageElement, b = reference.image;
      const geometry = current.media.frame, oldGeometry = reference.media.frame;
      if (Math.abs(a.naturalWidth / a.naturalHeight - b.naturalWidth / b.naturalHeight) > .001 ||
        geometry?.width !== oldGeometry?.width || geometry?.height !== oldGeometry?.height) {
        notes.push('The frames have different sizes.');
      }
      const bounds = a.getBoundingClientRect(), stage = this.stage.getBoundingClientRect();
      const rect = contain({ x: bounds.left - stage.left, y: bounds.top - stage.top, width: bounds.width, height: bounds.height },
        { width: a.naturalWidth, height: a.naturalHeight });
      if (rect) {
        this.rect = rect;
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(rect.width * scale)), h = Math.max(1, Math.round(rect.height * scale));
        if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = this.composite.width = w; this.canvas.height = this.composite.height = h; }
        Object.assign(this.canvas.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        const ctx = this.canvas.getContext('2d')!, layer = this.composite.getContext('2d')!;
        const paint = (context: CanvasRenderingContext2D, image: HTMLImageElement) => {
          context.fillStyle = '#181818'; context.fillRect(0, 0, w, h);
          const fit = contain({ x: 0, y: 0, width: w, height: h }, { width: image.naturalWidth, height: image.naturalHeight })!;
          context.drawImage(image, fit.x, fit.y, fit.width, fit.height);
        };
        paint(ctx, b);
        ctx.save();
        if (this.mode === 'wipe') {
          ctx.beginPath(); ctx.rect(w * value / 100, 0, w, h); ctx.clip(); paint(ctx, a);
        } else {
          paint(layer, a); ctx.globalAlpha = value / 100; ctx.drawImage(this.composite, 0, 0);
        }
        ctx.restore(); visible = true;
        Object.assign(this.divider.style, { left: `${rect.x + rect.width * value / 100}px`, top: `${rect.y}px`, height: `${rect.height}px` });
      }
    }
    this.info.textContent = notes.join(' '); this.info.hidden = !notes.length;
    this.canvas.hidden = !visible; this.divider.hidden = !visible || this.mode !== 'wipe';
    this.slider.disabled = !visible;
  }
}
