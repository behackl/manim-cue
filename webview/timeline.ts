import { extent, isCall, type Call, type Source, type Timeline } from '../src/timeline';
import type { Model } from '../src/protocol';
import { selectEvents, selectionRange, videoLoop, type SelectionMode } from '../src/selection';
import { videoFrames } from '../src/transport';
import { button, el, listen, post, saved, save, time } from './shared';

// The timeline view owns the selection: the inspected entry, the selected plays, and the
// loop. A click or a scrub asks the host to move the preview.

const app = document.getElementById('app')!; app.classList.add('timeline-app');
const header = el('header', 'toolbar');
const sceneName = el('span', 'scene-name');
const refresh = button('↻ Refresh', () => post({ kind: 'refresh' }));
const cancel = button('■ Cancel', () => post({ kind: 'cancel' }));
const loop = button('Loop selection', () => { looping = !looping; keep(); render(); });
const rangeLabel = el('span', 'selection-range');
const endedEarly = el('span', 'muted', 'The scene ended early.');
header.append(sceneName, refresh, cancel, loop, rangeLabel, endedEarly);
const banner = el('div', 'banner warning');
const workspace = el('div', 'workspace');
const chart = el('section', 'chart');
const controls = el('div', 'chart-controls');
const profile = el('span', 'muted');
const position = el('span', 'position', '');
controls.append(profile, button('−', () => changeZoom(zoom / 1.5), 'Zoom out'), button('+', () => changeZoom(zoom * 1.5), 'Zoom in'), button('Fit', () => changeZoom(1)), position);
const viewport = el('div', 'viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Timeline. Left and right arrows select plays and waits.');
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Timeline');
viewport.append(svg);
const legend = el('footer', 'legend');
for (const [style, text] of [['play', 'Play'], ['wait', 'Wait'], ['frozen', 'Still image'], ['skipped', 'Not in the video'], ['sound', 'Sound']]) {
  const item = el('span', 'legend-item'); item.append(el('span', `swatch ${style}`), text); legend.append(item);
}
chart.append(controls, viewport, legend);
const inspector = el('aside', 'inspector');
workspace.append(chart, inspector);
const error = el('pre', 'error');
const errorActions = el('div', 'error-actions');
const checkPython = button('Check Python', () => post({ kind: 'doctor' }));
errorActions.append(button('Show Log', () => post({ kind: 'logs' })), checkPython);
app.append(header, banner, workspace, error, errorActions);
let model: Model | undefined;
/** The selection belongs to one timeline key: the render's timeline keeps the entries of the inspection. */
let key: string | undefined, inspected: number | undefined, selectedEvents: number[] = [], anchor: number | undefined, looping = false;
const restored = saved() as { key?: string; inspected?: number; selectedEvents?: number[]; looping?: boolean } | undefined;
const keep = () => save({ key, inspected, selectedEvents, looping });
let zoom = Math.max(1, Math.min(128, Number((saved() as { zoom?: number } | undefined)?.zoom) || 1));
let scale = 1, lo = 0, width = 1, cursor = 0;
let marker: SVGLineElement | undefined;
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
function select(index: number, event?: MouseEvent | KeyboardEvent): void {
  const entries = model?.timeline?.entries, entry = entries?.[index];
  if (!entries || !entry) return;
  inspected = index;
  if (!model!.timelineOutdated) {
    if (isCall(entry)) {
      const mode: SelectionMode = event?.shiftKey ? 'range' : event?.metaKey || event?.ctrlKey ? 'toggle' : 'replace';
      selectedEvents = selectEvents(entries, selectedEvents, index, mode, anchor);
      if (mode !== 'range') anchor = index;
      if (mode === 'replace') seek(entry.start);
    } else { selectedEvents = []; anchor = undefined; seek(entry.start); }
  }
  keep(); render();
}
function seek(time: number): void { moveCursor(time); post({ kind: 'seek', time }); }
function moveCursor(value: number): void {
  cursor = value;
  marker?.setAttribute('x1', String(x(value))); marker?.setAttribute('x2', String(x(value)));
  position.textContent = time(value);
}
/** The selected range, and the part of it that the current video can loop. */
function selection(): { start: number; end: number; loop?: { start: number; end: number } } | undefined {
  const range = model?.timeline && selectionRange(model.timeline.entries, selectedEvents);
  if (!range || model!.timelineOutdated) return range;
  const video = model!.video;
  return { ...range, loop: !video || video.outdated ? range : videoLoop(range, video.rate, videoFrames(video.duration, video.rate), video.skipped) };
}
/** The host keeps the loop for the preview. */
function sendLoop(): void {
  const range = looping ? selection()?.loop : undefined;
  if (JSON.stringify(range) !== JSON.stringify(model?.loop)) post({ kind: 'loop', range });
}
function siteLabel(site: Source | null): string {
  if (!site) return 'No source line';
  return site.path ? `${site.path}, line ${site.line}` : `A file outside the scene folder, line ${site.line}`;
}
/** Class names without the module path; `.animate` calls have a private class. */
function animationNames(e: Call): string[] {
  return e.animations.map(a => { const name = a.type.split('.').at(-1)!; return name === '_MethodAnimation' ? '.animate' : name; });
}
function eventName(e: Call): string { return e.kind === 'wait' ? 'Wait' : animationNames(e).join(' + ') || 'Play'; }
/** A label for `width` pixels: cut with an ellipsis. The tooltip has the full text. */
function fit(text: string, width: number): string {
  const chars = Math.max(1, Math.floor(width / 7));
  return text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text;
}
const fileName = (file: string) => file.split(/[\\/]/u).at(-1)!;
const timeRange = (start: number, end: number) => `${start.toFixed(2)}–${end.toFixed(2)} s`;
function row(title: string, y: number): void {
  svg.append(node('line', { x1: 0, x2: width, y1: y + 31, y2: y + 31, class: 'lane-rule' }), node('text', { x: 10, y: y + 20, class: 'lane-label' }, title));
}
function selectable(g: SVGGElement, index: number, title: string): void {
  const selected = isCall(model?.timeline?.entries[index]) ? selectedEvents.includes(index) : inspected === index;
  g.classList.add('selectable'); if (selected) g.classList.add('selected');
  g.setAttribute('aria-pressed', String(!!selected));
  g.setAttribute('role', 'button'); g.setAttribute('tabindex', '0'); g.setAttribute('aria-label', title);
  g.append(node('title', {}, title));
  g.addEventListener('click', e => { e.stopPropagation(); select(index, e); });
  g.addEventListener('dblclick', () => post({ kind: 'navigate', index }));
  g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(index, e); } });
}
function render(): void {
  if (!model) return;
  const t = model.timeline;
  sceneName.textContent = model.scene;
  refresh.disabled = !model.scene; cancel.hidden = !model.busy;
  const range = selection(), available = !!range?.loop;
  if (!available) looping = false;
  loop.disabled = !available; loop.setAttribute('aria-pressed', String(looping));
  loop.title = model.timelineOutdated ? 'Refresh to loop the selection.' : range && !available ? 'The video has no frames for this selection.' : 'Select plays and waits: click, Cmd/Ctrl-click to add one, Shift-click for a range. Then press Play.';
  rangeLabel.textContent = range ? timeRange(range.start, range.end) : 'Select plays to loop';
  rangeLabel.classList.toggle('muted', !range);
  chart.classList.toggle('outdated', model.timelineOutdated);
  sendLoop();
  profile.textContent = model.profile ?? '';
  endedEarly.hidden = !t?.ended_early;
  banner.textContent = 'This timeline is outdated.';
  banner.hidden = !model.timelineOutdated;
  error.textContent = model.error ?? ''; error.hidden = !model.error;
  errorActions.hidden = !model.error;
  checkPython.hidden = !/python|import|module|environment|executable/i.test(model.error ?? '');
  svg.replaceChildren();
  if (!t) {
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '140');
    svg.append(node('text', { x: 24, y: 55, class: 'empty-label' }, model.busy ? 'Updating timeline…' : 'Click “▶ Open Manim Cue” above a scene class.'));
    inspector.replaceChildren(el('h3', '', 'Timeline'), el('p', '', 'The timeline shows the plays, waits, sections, captions and sounds of the scene.'));
    return;
  }
  let hi: number; [lo, hi] = extent(t);
  scale = Math.max(1, viewport.clientWidth - left - 24) / (hi - lo) * zoom;
  width = Math.max(viewport.clientWidth, left + (hi - lo) * scale + 24);
  // Pack overlapping captions and sounds into sublanes.
  const annotations = t.entries.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'caption' || e.kind === 'sound').sort(([a], [b]) => a.start - b.start);
  const lanes = new Map<number, number>(); const ends: Record<string, number[]> = { caption: [], sound: [] };
  for (const [d, i] of annotations) {
    const laneEnds = ends[d.kind]; const visualEnd = (d.kind === 'caption' ? Math.max(d.start, d.end) : d.kind === 'sound' ? d.start + (d.duration ?? 0) : d.start) + 14 / scale;
    let lane = laneEnds.findIndex(end => end <= d.start); if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = visualEnd; lanes.set(i, lane);
  }
  const sectionY = 34, eventY = 70, captionY = 108;
  const soundY = captionY + Math.max(1, ends.caption.length) * 32 + 6;
  const height = soundY + Math.max(1, ends.sound.length) * 32 + 18;
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  const hatch = node('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  hatch.append(node('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-line' }));
  const defs = node('defs'); defs.append(hatch);
  svg.append(defs, node('rect', { x: 0, y: 0, width, height, class: 'chart-bg' }));
  if (lo < 0) svg.append(node('rect', { x: left, y: 0, width: x(0) - left, height, class: 'outside-span' }));
  if (hi > t.duration) svg.append(node('rect', { x: x(t.duration), y: 0, width: x(hi) - x(t.duration), height, class: 'outside-span' }));
  const rawStep = 85 / scale, power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map(v => v * power).find(v => v >= rawStep)!;
  const minVisible = Math.max(lo, timeAt(svg.getBoundingClientRect().left + viewport.scrollLeft));
  // Only draw the visible grid ticks.
  for (let tick = Math.ceil(minVisible / step) * step, count = 0; tick <= hi && count < 400; tick += step, count++) {
    if (x(tick) > viewport.scrollLeft + viewport.clientWidth + 100) break;
    svg.append(node('line', { x1: x(tick), x2: x(tick), y1: 23, y2: height, class: 'grid-line' }), node('text', { x: x(tick) + 4, y: 17, class: 'tick-label' }, time(tick)));
  }
  if (range) {
    svg.append(node('rect', { x: x(range.start), y: 24, width: Math.max(0, x(range.end) - x(range.start)), height: height - 24,
      class: `loop-region${looping ? ' enabled' : ''}`, 'aria-label': `Selection ${timeRange(range.start, range.end)}` }));
  }
  row('Sections', sectionY); row('Plays & waits', eventY);
  for (let lane = 0; lane < Math.max(1, ends.caption.length); lane++) row(lane ? '' : 'Captions', captionY + lane * 32);
  for (let lane = 0; lane < Math.max(1, ends.sound.length); lane++) row(lane ? '' : 'Sounds', soundY + lane * 32);
  t.entries.forEach((d, index) => {
    if (isCall(d)) {
      const g = node('g', { class: `event ${d.kind}${d.frozen ? ' frozen' : ''}${d.skipped ? ' skipped' : ''}` }); const w = Math.max(3, (d.end - d.start) * scale);
      g.append(node('rect', { x: x(d.start), y: eventY + 3, width: w, height: 25, rx: 4 }));
      if (w > 34) g.append(node('text', { x: x(d.start) + 6, y: eventY + 20 }, fit(eventName(d), w - 12)));
      selectable(g, index, `${eventName(d)} · ${timeRange(d.start, d.end)}${d.skipped ? ' · Not in the video' : ''} · ${siteLabel(d.source)}`);
      svg.append(g); return;
    }
    const g = node('g', { class: `annotation ${d.kind}` });
    const start = d.start;
    let label: string;
    if (d.kind === 'section') {
      label = `${d.name}${d.skip_animations ? ' (skipped in the video)' : ''}`;
      g.append(node('path', { d: `M${x(start)},${sectionY + 2}v27m0,-24h7l-4,5h-3`, class: d.skip_animations ? 'skip-request' : '' }), node('text', { x: x(start) + 10, y: sectionY + 18 }, d.name));
    } else {
      const y = (d.kind === 'caption' ? captionY : soundY) + lanes.get(index)! * 32;
      if (d.kind === 'caption') {
        label = d.content; const w = Math.max(3, (d.end - d.start) * scale);
        g.append(node('rect', { x: x(start), y: y + 5, width: w, height: 21, rx: 3 }));
        if (w > 30) g.append(node('text', { x: x(start) + 5, y: y + 20 }, fit(d.content, w - 14)));
      } else {
        label = `${fileName(d.file)} · ${d.duration === null ? time(start) : timeRange(start, start + d.duration)}`;
        const w = d.duration === null ? 0 : Math.max(3, d.duration * scale);
        if (w) g.append(node('rect', { x: x(start), y: y + 6, width: w, height: 20, rx: 3 }));
        g.append(node('path', { d: `M${x(start)},${y + 8}l7,8 -7,8 -7,-8z` }));
        if (w > 30) g.append(node('text', { x: x(start) + 10, y: y + 20 }, fit(fileName(d.file), w - 18)));
      }
    }
    selectable(g, index, `${label}${d.kind === 'sound' ? '' : ` · ${d.kind === 'caption' ? timeRange(d.start, d.end) : time(start)}`} · ${siteLabel(d.source)}`);
    svg.append(g);
  });
  marker = node('line', { x1: x(cursor), x2: x(cursor), y1: 0, y2: height, class: 'playhead' });
  svg.append(marker); moveCursor(cursor); details(t);
}
function details(t: Timeline): void {
  inspector.replaceChildren();
  const index = inspected, entry = index === undefined ? undefined : t.entries[index];
  const detail = (label: string, value: string) => inspector.append(el('dt', '', label), el('dd', '', value));
  const note = (text: string) => inspector.append(el('p', 'note', text));
  if (!entry) {
    inspector.append(el('h3', '', t.scene));
    detail('Duration', time(t.duration));
    inspector.append(el('p', 'muted', 'Click an entry to see it here. Double-click an entry to go to its source line.'));
    return;
  }
  if (isCall(entry)) {
    inspector.append(el('h3', '', entry.kind === 'play' ? 'Play' : 'Wait'));
    detail('Time', timeRange(entry.start, entry.end));
    if (Math.abs(entry.run_time - (entry.end - entry.start)) > 1e-6) detail('Requested run time', time(entry.run_time));
    if (entry.frozen) note('Still image');
    if (entry.skipped) note('Not in the video (skipped section)');
    if (entry.kind === 'play') detail('Animations', animationNames(entry).join('\n'));
  } else if (entry.kind === 'section') {
    inspector.append(el('h3', '', 'Section'));
    detail('Name', entry.name); detail('Time', time(entry.start));
    if (entry.skip_animations) note('Skipped in the video');
  } else if (entry.kind === 'caption') {
    inspector.append(el('h3', '', 'Caption'));
    detail('Text', entry.content); detail('Time', timeRange(entry.start, entry.end));
  } else {
    inspector.append(el('h3', '', 'Sound'));
    detail('File', fileName(entry.file));
    detail('Time', entry.duration === null ? time(entry.start) : timeRange(entry.start, entry.start + entry.duration));
    if (entry.gain !== null) detail('Gain', `${entry.gain} dB`);
    if (entry.gain_to_background !== null) detail('Gain to background', `${entry.gain_to_background} dB`);
  }
  detail('Source', siteLabel(entry.source));
  const source = button('Go to source', () => post({ kind: 'navigate', index: index! }));
  source.disabled = !entry.source?.path || !!model?.timelineOutdated; inspector.append(source);
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
  if (model?.timeline) seek(timeAt(e.clientX));
});
viewport.addEventListener('pointercancel', () => { dragging = false; });
viewport.addEventListener('keydown', e => {
  if (!model?.timeline || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault(); const entries = model.timeline.entries, calls = entries.map((_, i) => i).filter(i => isCall(entries[i]));
  if (!calls.length) return;
  const current = calls.indexOf(inspected ?? -1);
  select(calls[Math.max(0, Math.min(calls.length - 1, current + (e.key === 'ArrowRight' ? 1 : -1)))], e);
});
let scrollFrame = false;
viewport.addEventListener('scroll', () => { if (!scrollFrame) { scrollFrame = true; requestAnimationFrame(() => { scrollFrame = false; render(); }); } });
new ResizeObserver(() => render()).observe(viewport);
listen(message => {
  if (message.kind === 'position') moveCursor(message.time);
  if (message.kind !== 'state') return;
  const first = !model;
  model = message.model;
  if (first) cursor = model.time;
  if (model.timelineKey !== key) {
    const same = first && restored?.key !== undefined && restored.key === model.timelineKey;
    key = model.timelineKey; inspected = same ? restored!.inspected : undefined;
    selectedEvents = same ? restored!.selectedEvents ?? [] : []; looping = same && !!restored!.looping; anchor = undefined;
    keep();
  }
  render();
});
post({ kind: 'ready' });
