import type { ExportChoice, ExportModel } from './export-settings';
import type { Timeline } from './timeline';
import type { SelectionMode, TimeRange } from './selection';
export interface Model {
  generation: number; scene: string; status: string; busy: boolean; stale: boolean;
  autoPreview: boolean; timeline?: Timeline; selected?: string; selectedEvents?: string[]; error?: string; python?: string;
  selection?: TimeRange & { enabled: boolean; available: boolean };
  profile?: string; linked: boolean; pairing: string; playbackTime?: number;
  canSeek?: boolean; canPlay?: boolean; mediaReady?: boolean; playIntent?: number;
  duration?: number; fps?: number; previewWidth?: number; hasMovie?: boolean;
  position?: { time: number; request: number };
  exportState?: ExportModel;
  comparison?: { enabled: boolean; pending: boolean; reference?: Model['media'] };
  media?: { uri: string; kind: 'video' | 'image'; token: string; old: boolean; duration: number; rate: number; seekTime?: number; sourceId?: string; sourceHash?: string; loop?: TimeRange;
    capture?: { requestedTime: number; time: number | null; frameIndex: number | null }; frame?: { width: number; height: number } };
}
export type HostMessage =
  | { kind: 'state'; model: Model }
  | { kind: 'position'; generation: number; time: number };
export type ViewMessage =
  | { kind: 'ready' }
  | { kind: 'refresh' | 'cancel' | 'preview' | 'logs' | 'export' | 'doctor' | 'settings' }
  | { kind: 'loopSelection'; generation: number; enabled: boolean }
  | { kind: 'step'; generation: number; direction: -1 | 1 }
  | { kind: 'saveFrame'; token: string }
  | { kind: 'openExport'; token?: string; time?: number }
  | { kind: 'closeExport'; id: string }
  | { kind: 'submitExport'; id: string; choice: ExportChoice }
  | { kind: 'cancelExport' }
  | { kind: 'compare'; generation: number; enabled: boolean; token?: string; time?: number; replace?: boolean }
  | { kind: 'referenceDisplayed'; token: string }
  | { kind: 'referenceError'; token: string; message: string }
  | { kind: 'select' | 'navigate'; generation: number; key: string; mode?: SelectionMode }
  | { kind: 'seek'; generation: number; time: number; immediate?: boolean }
  | { kind: 'play' | 'pause'; generation: number; request: number; token?: string }
  | { kind: 'displayed'; token: string; request: number; sequence: number }
  | { kind: 'playback'; token: string; time: number; currentTime: number; sequence: number; seekSequence: number; playing?: boolean }
  | { kind: 'copyPoint'; token: string; x: number; y: number }
  | { kind: 'mediaError'; token: string; message: string };
