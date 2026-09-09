import type { Model } from '../src/protocol';
import { contain } from '../src/measurement';
import { button, el, post, saved, save } from './shared';

type Media = NonNullable<Model['media']>;
type Target = { element: HTMLImageElement | HTMLVideoElement; media: Media; restoring: boolean; time?: number };

/** UI-only compositing. The host owns pinned files and acknowledges their lifetime. */
export class Comparison {
  enabled = false;
  private model?: Model;
  private target?: Target;
  private reference?: { image: HTMLImageElement; media: Media };
  private pending?: { image: HTMLImageElement; media: Media; timeout?: ReturnType<typeof setTimeout> };
  private failed?: string;
  private mode: 'wipe' | 'overlay' = (saved() as { compareMode?: string } | undefined)?.compareMode === 'overlay' ? 'overlay' : 'wipe';
  private wipeValue = 50;
  private overlayValue = 50;
  private toggle: HTMLButtonElement;
  private bar = el('div', 'compare-bar');
  private labels = el('div', 'compare-labels');
  private info = el('div', 'compare-info');
  private slider = el('input', 'compare-slider');
  private value = el('output', 'compare-value');
  private wipe = button('Wipe', () => this.setMode('wipe'), 'Reference left; current image right');
  private overlay = button('Overlay', () => this.setMode('overlay'), 'Blend the reference and current image');
  private replace = button('Replace reference', () => this.request(true), 'Pin the displayed still as the new reference');
  private canvas = el('canvas', 'compare-canvas');
  private composite = document.createElement('canvas');
  private divider = el('div', 'compare-divider');
  private rect?: { x: number; y: number; width: number; height: number };
  constructor(private stage: HTMLElement, controls: HTMLElement, private activate: () => void) {
    this.toggle = button('Compare', () => this.request(!this.enabled, false), 'Pin the displayed still; from a movie, capture a new still at its presented frame');
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
  private request(enabled: boolean, replace = true): void {
    if (!this.model) return;
    if (enabled) this.activate();
    if (replace) this.failed = undefined;
    const target = this.target;
    if (target?.element instanceof HTMLVideoElement) target.element.pause();
    post({ kind: 'compare', generation: this.model.generation, enabled, replace,
      token: target?.media.token, time: target?.element instanceof HTMLVideoElement ? target.time ?? target.element.currentTime : undefined });
  }
  disable(): void { if (this.enabled) this.request(false, false); }
  private cancelPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timeout); this.pending.image.onload = this.pending.image.onerror = null;
    this.pending.image.removeAttribute('src'); this.pending = undefined;
  }
  update(model: Model | undefined, target?: Target): void {
    this.model = model; this.target = target;
    this.enabled = model?.comparison?.enabled === true;
    this.toggle.setAttribute('aria-pressed', String(this.enabled)); this.bar.hidden = !this.enabled;
    if (this.enabled && target?.element instanceof HTMLVideoElement) target.element.pause();
    const usable = !!target && !target.restoring && (target.element instanceof HTMLImageElement ||
      model?.mediaReady === true && target.media.token === model.media?.token);
    this.toggle.disabled = !this.enabled && !usable;
    this.replace.disabled = !usable || !!model?.comparison?.pending;
    this.replace.textContent = model?.comparison?.reference ? 'Replace reference' : 'Pin reference';
    const media = model?.comparison?.reference;
    if (!media) {
      this.cancelPending(); this.reference = undefined; this.failed = undefined;
    } else if (media.token !== this.reference?.media.token && media.token !== this.pending?.media.token && media.token !== this.failed) {
      this.cancelPending();
      const image = new Image(), candidate: NonNullable<Comparison['pending']> = this.pending = { image, media };
      const fail = () => {
        if (this.pending !== candidate) return;
        this.cancelPending(); this.failed = media.token; this.draw();
        post({ kind: 'referenceError', token: media.token, message: 'Reference image could not be loaded or decoded. Previous reference retained.' });
      };
      candidate.timeout = setTimeout(fail, 15000);
      image.onload = () => { void image.decode().then(() => {
        if (this.pending !== candidate) return;
        clearTimeout(candidate.timeout); this.reference = candidate; this.pending = undefined; this.failed = undefined;
        this.draw(); post({ kind: 'referenceDisplayed', token: media.token });
      }).catch(fail); };
      image.onerror = fail; image.src = media.uri;
    } else if (media.token === this.reference?.media.token) this.cancelPending();
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
  private label(name: string, media?: Media): string {
    if (!media) return `${name}: —`;
    const capture = media.capture;
    return `${name}: ${capture?.time == null ? 'End state' : capture.time.toFixed(3) + ' s'} · source ${media.sourceHash?.slice(0, 8) ?? 'unknown'}`;
  }
  private draw(): void {
    this.wipe.setAttribute('aria-pressed', String(this.mode === 'wipe')); this.overlay.setAttribute('aria-pressed', String(this.mode === 'overlay'));
    const value = this.mode === 'wipe' ? this.wipeValue : this.overlayValue;
    this.slider.value = String(value); this.slider.setAttribute('aria-label', this.mode === 'wipe' ? 'Wipe position' : 'Current image opacity');
    this.slider.setAttribute('aria-valuetext', this.mode === 'wipe' ? `${Math.round(value)}% reference` : `${Math.round(value)}% current image`);
    this.value.textContent = `${Math.round(value)}% ${this.mode === 'wipe' ? 'reference' : 'current'}`;
    this.divider.setAttribute('aria-valuenow', String(Math.round(this.wipeValue)));
    this.rect = undefined;
    if (!this.enabled) { this.canvas.hidden = this.divider.hidden = true; return; }
    let visible = false;
    const target = this.target, reference = this.reference;
    const current = target?.element instanceof HTMLImageElement ? target : undefined;
    const stale = !!target && (this.model?.media?.old || target.media.sourceId !== this.model?.media?.sourceId);
    const updating = !!target && (!this.model?.mediaReady || target.media.token !== this.model?.media?.token || target.restoring);
    this.labels.textContent = `${this.label('Reference', reference?.media)}  |  ${current ? this.label('Current', current.media) : 'Current: movie — capture a still to compare'}${stale ? ' · OLD' : updating ? ' · updating' : ''}`;
    this.labels.title = 'Source IDs are primary-file SHA-256 prefixes, not complete dependency revisions. Reference pixels stay fixed until explicitly replaced.';
    const notes: string[] = [];
    if (this.model?.comparison?.pending) notes.push('Capturing a new still at the movie frame (fresh execution, not movie pixel extraction)…');
    else if (this.pending) notes.push('Loading reference…');
    else if (this.failed) notes.push('Reference could not be decoded; previous reference retained. Replace reference to retry.');
    else if (!reference) notes.push('No reference pinned. Use Pin reference to try again.');
    if (current && reference) {
      const a = current.element as HTMLImageElement, b = reference.image;
      const geometry = current.media.frame, oldGeometry = reference.media.frame;
      if (Math.abs(a.naturalWidth / a.naturalHeight - b.naturalWidth / b.naturalHeight) > .001 ||
        geometry?.width !== oldGeometry?.width || geometry?.height !== oldGeometry?.height) {
        notes.push('Different aspect/frame geometry — centred fit, no automatic alignment.');
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
