export interface RenderSettings {
  width: number; height: number; fps: number; crf: number;
  preset: 'veryfast' | 'medium' | 'slow'; options: string;
}
export type ExportKind = 'frame' | 'video' | 'timeline';
export interface ExportChoice { kind: ExportKind; method: 'copy' | 'render'; settings: RenderSettings }
export interface ExportDialogModel {
  id: string; scene: string; choice: ExportChoice; aspect: number; previewSize: { width: number; height: number };
  frame?: { kind: 'image' | 'video'; description: string; uri?: string }; video?: string; timeline?: string;
  canCapture: boolean; dirty: boolean; newer: boolean; error?: string;
}
export interface ExportModel { dialog?: ExportDialogModel; busy: boolean; nativeBusy: boolean; status?: string; requestOpen?: boolean }

export function encoderOptions(text: string): Record<string, string> {
  if (typeof text !== 'string' || text.length > 8192) throw new Error('Encoder options must be at most 8 KiB.');
  const result: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const equals = line.indexOf('='), key = line.slice(0, equals).trim().toLowerCase(), value = line.slice(equals + 1).trim();
    if (equals < 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(key) || !value || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Use one codec key=value per line (no control characters).');
    }
    if (['crf', 'preset'].includes(key.toLowerCase())) throw new Error(`Set ${key} using the quality/effort controls.`);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate encoder option: ${key}`);
    result[key] = value;
    if (Object.keys(result).length > 32) throw new Error('Use at most 32 additional encoder options.');
  }
  return result;
}
export function renderSettings(value: unknown): RenderSettings {
  if (!value || typeof value !== 'object') throw new Error('Missing render settings.');
  const s = value as RenderSettings;
  if (![s.width, s.height].every(n => Number.isInteger(n) && n >= 64 && n <= 8192 && n % 2 === 0) || s.width * s.height > 32_000_000) {
    throw new Error('Use even dimensions from 64 to 8192 pixels, at most 32 megapixels.');
  }
  if (!Number.isFinite(s.fps) || s.fps < 1 || s.fps > 120) throw new Error('Frame rate must be between 1 and 120 fps.');
  if (!Number.isInteger(s.crf) || s.crf < 0 || s.crf > 51) throw new Error('CRF must be an integer from 0 to 51.');
  if (!['veryfast', 'medium', 'slow'].includes(s.preset)) throw new Error('Choose an encoding effort.');
  encoderOptions(s.options);
  return { width: s.width, height: s.height, fps: s.fps, crf: s.crf, preset: s.preset, options: s.options };
}
/** Copies may retain an unvalidated host render draft; stored preferences and new renders must be valid. */
export function exportChoice(value: unknown, copySettings?: RenderSettings): ExportChoice {
  const c = value as ExportChoice | undefined;
  if (!c || !['frame', 'video', 'timeline'].includes(c.kind) || !['copy', 'render'].includes(c.method)) throw new Error('Invalid export choice.');
  return { kind: c.kind, method: c.method,
    settings: copySettings && !(c.kind === 'video' && c.method === 'render') ? { ...copySettings } : renderSettings(c.settings) };
}
/** Short-edge presets preserve orientation/aspect; never change frame rate. */
export function exportSize(shortEdge: number, aspect: number): { width: number; height: number } {
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(shortEdge) || shortEdge <= 0) throw new Error('Invalid aspect ratio.');
  const even = (n: number) => Math.round(n / 2) * 2;
  return aspect >= 1 ? { width: even(shortEdge * aspect), height: even(shortEdge) } : { width: even(shortEdge), height: even(shortEdge / aspect) };
}
