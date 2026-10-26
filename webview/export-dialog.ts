import type { Model } from '../src/protocol';
import { exportSize, renderSettings, type ExportChoice, type ExportDialogModel, type ExportKind } from '../src/export-settings';
import { button, el, post } from './shared';

export class ExportDialog {
  private modal = el('dialog', 'export-dialog');
  private form = el('form');
  private body = el('div', 'export-body');
  private modes = el('div', 'export-modes');
  private summary = el('p', 'export-summary');
  private image = el('img', 'export-thumbnail');
  private methods = el('div', 'export-methods');
  private fields = el('fieldset', 'export-fields');
  private error = el('p', 'export-error');
  private warning = el('p', 'export-note');
  private latest = button('Use the latest preview', () => this.open());
  private submit = el('button', 'export-submit');
  private kindButtons = new Map<ExportKind, HTMLButtonElement>();
  private copy = button('Save the preview video', () => { this.choice!.method = 'copy'; this.render(); });
  private renderVideo = button('Render a new video', () => { this.choice!.method = 'render'; this.render(); });
  private resolution = el('select');
  private width = el('input'); private height = el('input'); private fps = el('input'); private crf = el('input');
  private lock = el('input'); private effort = el('select'); private options = el('textarea');
  private data?: ExportDialogModel;
  private model?: Model;
  private choice?: ExportChoice;
  private focus?: HTMLElement;
  private requested = false;
  private closedId?: string;
  private status = el('div', 'export-status');
  private statusText = el('span');
  private cancelJob = button('Cancel export', () => post({ kind: 'cancelExport' }));
  constructor(private open: () => void, controls: HTMLElement) {
    const heading = el('h2', '', 'Export'); heading.id = 'export-heading';
    this.modal.setAttribute('aria-labelledby', heading.id);
    const tabs: [ExportKind, string][] = [['frame', 'Frame'], ['video', 'Video'], ['timeline', 'Timeline']];
    for (const [kind, label] of tabs) {
      const b = button(label, () => { this.choice!.kind = kind; this.render(); }); this.kindButtons.set(kind, b); this.modes.append(b);
    }
    this.methods.append(this.copy, this.renderVideo);
    const field = (label: string, input: HTMLElement) => { input.setAttribute('aria-label', label); const l = el('label'); l.append(el('span', '', label), input); this.fields.append(l); };
    const select = (element: HTMLSelectElement, options: [string, string][]) => {
      for (const [value, label] of options) { const o = el('option', '', label); o.value = value; element.append(o); }
    };
    select(this.resolution, [['preview', 'Same as the preview'], ['720', '720p'], ['1080', '1080p'], ['2160', '2160p'], ['custom', 'Custom']]);
    select(this.effort, [['veryfast', 'Fast'], ['medium', 'Balanced'], ['slow', 'Slow']]);
    for (const input of [this.width, this.height, this.fps, this.crf]) input.type = 'number';
    for (const input of [this.width, this.height]) { input.min = '64'; input.max = '8192'; input.step = '2'; }
    this.fps.min = '1'; this.fps.max = '120'; this.fps.step = 'any'; this.crf.min = '0'; this.crf.max = '51';
    this.lock.type = 'checkbox'; this.lock.checked = true;
    field('Resolution', this.resolution); field('Keep aspect ratio', this.lock); field('Width (px)', this.width); field('Height (px)', this.height);
    field('Frame rate (fps)', this.fps); field('Quality (CRF)', this.crf); field('Encoding effort', this.effort);
    const details = el('details'), legend = el('summary', '', 'Advanced');
    const label = el('label', '', 'Encoder options (one key=value per line)');
    this.options.rows = 4; this.options.maxLength = 8192; this.options.spellcheck = false;
    this.options.placeholder = 'threads=4'; label.append(this.options);
    details.append(legend, el('p', '', 'H.264 video (libx264, yuv420p)'), label,
      el('p', 'export-note', 'The quality and the encoding effort come from the controls above.'));
    this.fields.append(details, el('p', 'export-note', 'The video includes the sounds of the scene. A lower CRF gives a higher quality and a larger file.'));
    this.error.setAttribute('role', 'alert'); this.image.alt = 'Frame to export';
    this.submit.type = 'submit';
    const footer = el('footer'); footer.append(button('Cancel', () => this.close()), this.submit);
    this.body.append(this.modes, this.latest, this.summary, this.image, this.methods, this.fields, this.warning, this.error);
    this.form.append(heading, this.body, footer); this.modal.append(this.form); document.body.append(this.modal);
    this.status.append(this.statusText, this.cancelJob); this.status.hidden = true; controls.after(this.status);
    this.modal.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
    this.form.addEventListener('submit', e => {
      e.preventDefault(); if (!this.data || !this.choice || this.submit.disabled) return;
      post({ kind: 'submitExport', id: this.data.id, choice: this.readChoice() });
    });
    this.resolution.addEventListener('change', () => {
      if (!this.data) return;
      const size = this.resolution.value === 'preview' ? this.data.previewSize : this.resolution.value !== 'custom' ? exportSize(Number(this.resolution.value), this.data.aspect) : undefined;
      if (size) { this.width.value = String(size.width); this.height.value = String(size.height); this.lock.checked = true; }
      this.render();
    });
    for (const [input, other, invert] of [[this.width, this.height, false], [this.height, this.width, true]] as const) {
      input.addEventListener('input', () => {
        this.resolution.value = 'custom';
        if (this.lock.checked && this.data) other.value = String(Math.round(input.valueAsNumber * (invert ? this.data.aspect : 1 / this.data.aspect) / 2) * 2);
        this.render();
      });
    }
    this.lock.addEventListener('change', () => {
      if (this.lock.checked && this.data) { this.height.value = String(Math.round(this.width.valueAsNumber / this.data.aspect / 2) * 2); this.resolution.value = 'custom'; }
      this.render();
    });
    for (const input of [this.fps, this.crf, this.effort, this.options]) input.addEventListener('input', () => this.render());
  }
  private close(notify = true): void {
    this.closedId = this.data?.id;
    if (notify && this.data) post({ kind: 'closeExport', id: this.data.id });
    this.data = undefined; this.image.removeAttribute('src'); this.modal.close(); this.focus?.focus();
  }
  update(model: Model): void {
    this.model = model;
    const state = model.exportState;
    this.status.hidden = !state?.status; this.statusText.textContent = state?.status ?? ''; this.cancelJob.hidden = !state?.busy;
    if (state?.requestOpen && !this.requested) { this.requested = true; this.open(); }
    if (!state?.requestOpen) this.requested = false;
    const data = state?.dialog;
    if (!data) { if (this.modal.open) this.close(false); return; }
    if (data.id === this.closedId) return;
    if (!this.modal.open) {
      this.choice = { ...data.choice, settings: { ...data.choice.settings } };
      const s = this.choice.settings;
      this.width.value = String(s.width); this.height.value = String(s.height); this.fps.value = String(s.fps); this.crf.value = String(s.crf);
      this.effort.value = s.preset; this.options.value = s.options;
      this.resolution.value = ['preview', '720', '1080', '2160'].find(key => {
        const size = key === 'preview' ? data.previewSize : exportSize(Number(key), data.aspect);
        return size.width === s.width && size.height === s.height;
      }) ?? 'custom';
      this.lock.checked = Math.abs(s.width / s.height - data.aspect) < 2 / s.height;
      if (!this.modal.open) { this.focus = document.activeElement as HTMLElement; this.modal.showModal(); }
    }
    this.data = data; this.render();
  }
  private readChoice(): ExportChoice {
    return { ...this.choice!, settings: { width: this.width.valueAsNumber, height: this.height.valueAsNumber, fps: this.fps.valueAsNumber,
      crf: this.crf.valueAsNumber, preset: this.effort.value as ExportChoice['settings']['preset'], options: this.options.value } };
  }
  private render(): void {
    const d = this.data, choice = this.choice;
    if (!d || !choice) return;
    if (choice.kind === 'video' && !d.canExportVideo) choice.kind = 'frame';
    this.kindButtons.get('video')!.hidden = !d.canExportVideo;
    const { kind, method } = choice, rendering = kind === 'video' && method === 'render', capture = kind === 'frame' && d.frame?.kind === 'video';
    for (const [k, b] of this.kindButtons) b.setAttribute('aria-pressed', String(k === kind));
    this.methods.hidden = kind !== 'video'; this.fields.hidden = !rendering; this.fields.disabled = !rendering;
    this.copy.setAttribute('aria-pressed', String(method === 'copy')); this.renderVideo.setAttribute('aria-pressed', String(method === 'render'));
    this.latest.hidden = !d.newer; this.latest.title = 'The preview changed after you opened this dialog.';
    this.summary.textContent = `${d.scene} — ` + (kind === 'frame' ? d.frame?.description ?? 'No frame yet.' : kind === 'timeline' ? d.timeline ?? 'No timeline yet.' : rendering ? 'Renders the whole scene with these settings.' : d.video ?? 'No preview video yet. Choose “Render a new video”.');
    this.image.hidden = kind !== 'frame' || !d.frame?.uri;
    if (d.frame?.uri && this.image.getAttribute('src') !== d.frame.uri) this.image.src = d.frame.uri;
    this.warning.textContent = capture ? 'Cue runs the scene to make this frame at the preview size.' : kind === 'frame' ? 'Saves the shown frame.' : rendering ? `${!this.lock.checked ? 'A different aspect ratio changes the framing. ' : ''}${d.dirty ? 'The scene file has unsaved changes. Cue asks you to save it first.' : ''}` : kind === 'video' ? 'Saves a copy of the preview video.' : 'Saves the timeline as JSON.';
    let error = d.error ?? '', invalid = false;
    if (rendering) { try { renderSettings(this.readChoice().settings); } catch (e) { error = (e as Error).message; invalid = true; } }
    this.error.textContent = error; this.error.hidden = !error;
    const available = rendering || (kind === 'frame' ? !!d.frame && (!capture || d.canCapture) : kind === 'video' ? !!d.video : !!d.timeline);
    this.submit.disabled = !available || !!this.model?.exportState?.busy || invalid;
    this.submit.textContent = rendering ? 'Render and save…' : kind === 'frame' ? 'Save PNG…' : kind === 'video' ? 'Save MP4…' : 'Save JSON…';
    if (capture && !d.canCapture) this.warning.textContent = 'Refresh to update the frame first.';
  }
}
