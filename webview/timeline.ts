import { extent, soundLabel, type Timeline, type Event, type Site } from '../src/timeline';
import type { Model } from '../src/protocol';
import { button, el, listen, post, saved, save, seconds } from './shared';

const app = document.getElementById('app')!; app.classList.add('timeline-app');
const header = el('header', 'toolbar');
const sceneName = el('span', 'scene-name');
const status = el('span', 'status');
const refresh = button('↻ Refresh', () => post({ kind: 'refresh' }));
const cancel = button('■ Cancel', () => post({ kind: 'cancel' }));
const loop = button('Loop selection', () => { if (model) post({ kind: 'loopSelection', generation: model.generation, enabled: !model.selection?.enabled }); });
const rangeLabel = el('span', 'selection-range');
header.append(sceneName, refresh, cancel, loop, rangeLabel, status);
const banner = el('div', 'banner');
const workspace = el('div', 'workspace');
const chart = el('section', 'chart');
const controls = el('div', 'chart-controls');
const profile = el('span', 'muted');
const position = el('span', 'position', '');
controls.append(profile, button('−', () => changeZoom(zoom / 1.5), 'Zoom out'), button('+', () => changeZoom(zoom * 1.5), 'Zoom in'), button('Fit', () => changeZoom(1)), position);
const viewport = el('div', 'viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Execution timeline; left and right select timed calls');
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Observed event and declaration lanes');
viewport.append(svg);
const legend = el('footer', 'legend', 'Observed spans, not nominal durations · ◆ sound cue · Counts describe evaluation, not media frames');
chart.append(controls, viewport, legend);
const inspector = el('aside', 'inspector');
workspace.append(chart, inspector);
const error = el('pre', 'error');
const errorActions = el('div', 'error-actions');
const checkPython = button('Check Python', () => post({ kind: 'doctor' }));
errorActions.append(button('Show logs', () => post({ kind: 'logs' })), checkPython);
app.append(header, banner, workspace, error, errorActions);
let model: Model | undefined;
let zoom = Math.max(1, Math.min(128, Number((saved() as { zoom?: number } | undefined)?.zoom) || 1));
let scale = 1, lo = 0, width = 1, cursor = 0;
let marker: SVGLineElement | undefined, ghost: SVGLineElement | undefined;
const left = 88;
function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const n = document.createElementNS(svg.namespaceURI, tag) as SVGElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
  if (text !== undefined) n.textContent = text;
  return n;
}
function x(time: number): number { return left + (time - lo) * scale; }
function timeAt(clientX: number): number { return lo + (clientX - svg.getBoundingClientRect().left - left) / scale; }
function changeZoom(value: number): void {
  const center = lo + (viewport.scrollLeft + viewport.clientWidth / 2 - left) / scale;
  zoom = Math.max(1, Math.min(128, value)); save({ zoom }); render();
  viewport.scrollLeft = Math.max(0, x(center) - viewport.clientWidth / 2);
}
function select(key: string, event?: MouseEvent | KeyboardEvent): void {
  if (!model) return;
  const mode = key.startsWith('event:') ? event?.shiftKey ? 'range' : event?.metaKey || event?.ctrlKey ? 'toggle' : 'replace' : 'replace';
  post({ kind: 'select', generation: model.generation, key, mode });
}
function seek(time: number): void {
  if (!model?.timeline) return;
  if (model.linked) {
    ghost?.setAttribute('x1', String(x(time))); ghost?.setAttribute('x2', String(x(time))); ghost?.setAttribute('visibility', 'visible');
    post({ kind: 'seek', generation: model.generation, time });
  } else { moveCursor(time); post({ kind: 'seek', generation: model.generation, time }); }
}
function moveCursor(time: number): void {
  cursor = time;
  marker?.setAttribute('x1', String(x(time))); marker?.setAttribute('x2', String(x(time)));
  position.textContent = `${model?.linked ? 'Video' : 'Selected'} ${seconds(time)}`;
}
function siteLabel(site: Site | null): string {
  if (!site) return 'Source unavailable';
  return `${site.path ?? site.display_name ?? 'Generated source'}:${site.line}${site.occurrence === null ? '' : ` · occurrence ${site.occurrence + 1}`} (${site.coverage})`;
}
function eventName(e: Event): string {
  if (e.kind === 'wait') return 'Wait';
  const types = e.animations.map(a => a.type.split('.').at(-1) === '_MethodAnimation' ? '.animate' : a.type.split('.').at(-1)!);
  return types.join(' + ') || 'Play';
}
function row(title: string, y: number): void {
  svg.append(node('line', { x1: 0, x2: width, y1: y + 31, y2: y + 31, class: 'lane-rule' }), node('text', { x: 10, y: y + 20, class: 'lane-label' }, title));
}
function selectable(g: SVGGElement, key: string, title: string): void {
  const selected = key.startsWith('event:') ? model?.selectedEvents?.includes(key.slice(6)) : model?.selected === key;
  g.classList.add('selectable'); if (selected) g.classList.add('selected');
  g.setAttribute('aria-pressed', String(!!selected));
  g.setAttribute('role', 'button'); g.setAttribute('tabindex', '0'); g.setAttribute('aria-label', title);
  g.append(node('title', {}, title));
  g.addEventListener('click', e => { e.stopPropagation(); select(key, e); });
  g.addEventListener('dblclick', () => { if (model) post({ kind: 'navigate', generation: model.generation, key }); });
  g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(key, e); } });
}
function render(): void {
  if (!model) return;
  const t = model.timeline;
  sceneName.textContent = model.scene;
  status.textContent = model.status; status.classList.toggle('busy', model.busy);
  refresh.disabled = !model.scene; cancel.hidden = !model.busy;
  loop.disabled = !model.selection?.available; loop.setAttribute('aria-pressed', String(!!model.selection?.enabled));
  loop.title = model.stale ? 'Refresh before looping this selection' : model.selection && !model.selection.available ? 'This selection cannot be mapped to the current movie frames' : 'Select events (Cmd/Ctrl-click to toggle, Shift-click for a range). Loop includes intervening events. Press Play to start.';
  rangeLabel.textContent = model.selection ? `${model.selection.start.toFixed(3)}–${model.selection.end.toFixed(3)} s${model.stale ? ' · stale' : ''}` : 'Select events to loop';
  profile.textContent = model.profile ?? 'Saved source';
  banner.textContent = `${model.stale ? 'STALE OBSERVATION — ' : ''}${model.pairing}`;
  banner.hidden = !model.stale && !model.pairing;
  banner.classList.toggle('warning', model.stale || (!!model.media && !model.linked));
  error.textContent = model.error ?? ''; error.hidden = !model.error;
  errorActions.hidden = !model.error;
  checkPython.hidden = !/python|import|module|environment|executable/i.test(model.error ?? '');
  svg.replaceChildren();
  if (!t) {
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '140');
    svg.append(node('text', { x: 24, y: 55, class: 'empty-label' }, model.busy ? 'Running Python to observe the actual timeline…' : 'Open Manim Cue above a Scene class.'));
    inspector.replaceChildren(el('h3', '', 'Runtime, not estimates'), el('p', '', 'Plays, waits, captions and sounds appear only after successful evaluation. No timeline is inferred from source text.'));
    return;
  }
  let hi: number; [lo, hi] = extent(t);
  scale = Math.max(1, viewport.clientWidth - left - 24) / (hi - lo) * zoom;
  width = Math.max(viewport.clientWidth, left + (hi - lo) * scale + 24);
  // Pack overlapping annotations into sublanes; reached order is retained in details.
  const annotations = t.declarations.filter(d => d.kind !== 'section').sort((a, b) => (a as { start: number }).start - (b as { start: number }).start || a.order - b.order);
  const lanes = new Map<number, number>(); const ends: Record<string, number[]> = { caption: [], sound: [] };
  for (const d of annotations) {
    const laneEnds = ends[d.kind]; const visualEnd = (d.kind === 'caption' ? Math.max(d.start, d.end) : d.start + (d.duration ?? 0)) + 14 / scale;
    let lane = laneEnds.findIndex(end => end <= d.start); if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = visualEnd; lanes.set(d.order, lane);
  }
  const sectionY = 34, eventY = 70, captionY = 108;
  const soundY = captionY + Math.max(1, ends.caption.length) * 32 + 6;
  const height = soundY + Math.max(1, ends.sound.length) * 32 + 18;
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  svg.append(node('rect', { x: 0, y: 0, width, height, class: 'chart-bg' }));
  if (t.start > lo) svg.append(node('rect', { x: left, y: 0, width: x(t.start) - left, height, class: 'outside-span' }));
  if (hi > t.end) svg.append(node('rect', { x: x(t.end), y: 0, width: x(hi) - x(t.end), height, class: 'outside-span' }));
  const rawStep = 85 / scale, power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map(v => v * power).find(v => v >= rawStep)!;
  const minVisible = Math.max(lo, timeAt(svg.getBoundingClientRect().left + viewport.scrollLeft));
  // Only draw visible grid ticks (event geometry still retains exact exported spans).
  for (let tick = Math.ceil(minVisible / step) * step, count = 0; tick <= hi && count < 400; tick += step, count++) {
    if (x(tick) > viewport.scrollLeft + viewport.clientWidth + 100) break;
    svg.append(node('line', { x1: x(tick), x2: x(tick), y1: 23, y2: height, class: 'grid-line' }), node('text', { x: x(tick) + 4, y: 17, class: 'tick-label' }, seconds(tick)));
  }
  if (model.selection) {
    const r = model.selection;
    svg.append(node('rect', { x: x(r.start), y: 24, width: Math.max(0, x(r.end) - x(r.start)), height: height - 24,
      class: `loop-region${r.enabled ? ' enabled' : ''}${model.stale ? ' stale' : ''}`, 'aria-label': `Selected interval ${seconds(r.start)} to ${seconds(r.end)}` }));
  }
  row('Sections', sectionY); row('Events', eventY);
  for (let lane = 0; lane < Math.max(1, ends.caption.length); lane++) row(lane ? '' : 'Captions', captionY + lane * 32);
  for (let lane = 0; lane < Math.max(1, ends.sound.length); lane++) row(lane ? '' : 'Sounds', soundY + lane * 32);
  for (const e of t.events) {
    const g = node('g', { class: `event ${e.kind}` }); const w = Math.max(3, (e.end - e.start) * scale);
    g.append(node('rect', { x: x(e.start), y: eventY + 3, width: w, height: 25, rx: 4 }));
    if (w > 34) { const label = eventName(e); const chars = Math.max(1, Math.floor((w - 12) / 7)); g.append(node('text', { x: x(e.start) + 6, y: eventY + 20 }, label.length > chars ? `${label.slice(0, Math.max(0, chars - 1))}…` : label)); }
    selectable(g, `event:${e.id}`,  `${eventName(e)} · ${seconds(e.start)} → ${seconds(e.end)} · nominal ${seconds(e.nominal_duration)} · ${siteLabel(e.source)}`);
    svg.append(g);
  }
  for (const d of t.declarations) {
    const g = node('g', { class: `declaration ${d.kind}` });
    const start = d.kind === 'section' ? d.at : d.start;
    let label: string;
    if (d.kind === 'section') {
      label = `${d.name}${d.skip_requested ? ' (skip requested; ignored by evaluation)' : ''}`;
      g.append(node('path', { d: `M${x(start)},${sectionY + 2}v27m0,-24h7l-4,5h-3`, class: d.skip_requested ? 'skip-request' : '' }), node('text', { x: x(start) + 10, y: sectionY + 18 }, d.name));
    } else {
      const y = (d.kind === 'caption' ? captionY : soundY) + lanes.get(d.order)! * 32;
      if (d.kind === 'caption') {
        label = d.content; const w = Math.max(3, (d.end - d.start) * scale);
        g.append(node('rect', { x: x(start), y: y + 5, width: w, height: 21, rx: 3 }));
        if (w > 30) g.append(node('text', { x: x(start) + 5, y: y + 20 }, d.content.slice(0, Math.max(1, Math.floor((w - 14) / 7)))));
      } else {
        label = `${soundLabel(d)} · ${d.duration === null ? 'duration unknown' : seconds(d.duration)}`;
        if (d.duration !== null) g.append(node('rect', { x: x(start), y: y + 6, width: Math.max(3, d.duration * scale), height: 20, rx: 3 }));
        g.append(node('path', { d: `M${x(start)},${y + 8}l7,8 -7,8 -7,-8z` }));
      }
    }
    selectable(g, `declaration:${d.order}`,  `${label} · placed ${seconds(start)} · declared ${seconds(d.at)} · ${siteLabel(d.source)}`);
    svg.append(g);
  }
  marker = node('line', { x1: x(cursor), x2: x(cursor), y1: 0, y2: height, class: model.linked ? 'playhead video-playhead' : 'playhead' });
  ghost = node('line', { x1: 0, x2: 0, y1: 0, y2: height, class: 'ghost', visibility: 'hidden' });
  svg.append(marker, ghost); moveCursor(cursor); details(t);
}
function details(t: Timeline): void {
  inspector.replaceChildren();
  const e = model?.selected?.startsWith('event:') ? t.events.find(e => `event:${e.id}` === model?.selected) : undefined;
  const d = model?.selected?.startsWith('declaration:') ? t.declarations.find(d => `declaration:${d.order}` === model?.selected) : undefined;
  const entry = e ?? d;
  function detail(label: string, value: string) { inspector.append(el('dt', '', label), el('dd', '', value)); }
  if (!entry) {
    inspector.append(el('h3', '', t.scene.name));
    detail('Observed execution', `${seconds(t.start)} → ${seconds(t.end)}`);
    detail('Reached', `${t.events.length} timed calls · ${t.declarations.length} declarations`);
    detail('Policy', t.policy); detail('Completion', t.termination);
    inspector.append(el('p', 'muted', 'Click a bar or cue to inspect it. Double-click to navigate to its reached source line.'));
  } else {
    inspector.append(el('h3', '', e ? `${eventName(e)} · call ${e.ordinal + 1}` : `${d!.kind} declaration`));
    if (e) {
      detail('Observed span', `${seconds(e.start)} → ${seconds(e.end)} (${seconds(e.end - e.start)})`);
      detail('Nominal request', seconds(e.nominal_duration));
      detail('Evaluated samples', String(e.samples)); detail('Logical frozen intervals', String(e.hold_intervals));
      detail('Animations', e.animations.map(a => `${a.type} (${seconds(a.run_time)})`).join('\n') || 'None');
    } else if (d) {
      detail('Reached order / boundary', `${d.order} / ${d.event_boundary}`); detail('Declared at', seconds(d.at));
      if (d.kind === 'section') { detail('Name / type', `${d.name} · ${d.type}`); detail('Skip requested', d.skip_requested ? 'Yes — evaluation still ran this section' : 'No'); }
      if (d.kind === 'caption') { detail('Caption', d.content); detail('Placement', `${seconds(d.start)} → ${seconds(d.end)}`); }
      if (d.kind === 'sound') {
        detail('Sound', soundLabel(d)); detail('Placement', seconds(d.start)); detail('Duration', d.duration === null ? 'Unknown — not decoded' : seconds(d.duration));
        detail('Gain', d.gain === null ? 'Unspecified' : `${d.gain} dB`); detail('Asset', d.asset.resolution); detail('Options', JSON.stringify(d.options));
      }
    }
    detail('Source', siteLabel(entry.source));
    const source = button('Go to source', () => post({ kind: 'navigate', generation: model!.generation, key: model!.selected! }));
    source.disabled = !entry.source?.path || !!entry.source.outside_root || !!model?.stale; inspector.append(source);
  }
  inspector.append(el('p', 'coverage', `Source coverage: ${t.source.coverage}. Helpers, assets and external state are not fully fingerprinted.`));
}
let dragging = false, nextSeek: number | undefined, scheduled = false;
viewport.addEventListener('pointerdown', e => {
  if ((e.target as Element).closest('.selectable') || e.button !== 0) return;
  dragging = true; viewport.setPointerCapture(e.pointerId); seek(timeAt(e.clientX));
});
viewport.addEventListener('pointermove', e => {
  if (!dragging) return;
  nextSeek = timeAt(e.clientX);
  if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; if (nextSeek !== undefined) seek(nextSeek); }); }
});
viewport.addEventListener('pointerup', e => {
  if (!dragging) return;
  dragging = false; nextSeek = undefined;
  if (model?.timeline) post({ kind: 'seek', generation: model.generation, time: timeAt(e.clientX), immediate: true });
});
viewport.addEventListener('pointercancel', () => { dragging = false; });
viewport.addEventListener('keydown', e => {
  if (!model?.timeline || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault(); const events = model.timeline.events; if (!events.length) return;
  const current = events.findIndex(event => `event:${event.id}` === model!.selected);
  const entry = events[Math.max(0, Math.min(events.length - 1, current + (e.key === 'ArrowRight' ? 1 : -1)))]; select(`event:${entry.id}`, e);
});
let scrollFrame = false;
viewport.addEventListener('scroll', () => { if (!scrollFrame) { scrollFrame = true; requestAnimationFrame(() => { scrollFrame = false; render(); }); } });
new ResizeObserver(() => render()).observe(viewport);
listen(message => {
  if (message.kind === 'state') {
    model = message.model;
    cursor = model.position?.time ?? model.playbackTime ?? model.timeline?.start ?? 0;
    if (model.linked && model.mediaReady !== false && model.playbackTime !== undefined) cursor = model.playbackTime;
    render();
  } else if (message.kind === 'position' && message.generation === model?.generation && model.linked) {
    moveCursor(message.time); ghost?.setAttribute('visibility', 'hidden');
  }
});
post({ kind: 'ready' });
