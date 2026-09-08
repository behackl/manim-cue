import type { Timeline } from './timeline';
export interface Model {
  generation: number; scene: string; status: string; busy: boolean; stale: boolean;
  autoPreview: boolean; timeline?: Timeline; selected?: string; error?: string; python?: string;
  profile?: string; linked: boolean; pairing: string; playbackTime?: number;
  position?: { time: number; request: number };
  media?: { uri: string; kind: 'video' | 'image'; token: string; old: boolean; duration: number; rate: number; frame?: { width: number; height: number } };
}
export type HostMessage =
  | { kind: 'state'; model: Model }
  | { kind: 'position'; generation: number; time: number };
export type ViewMessage =
  | { kind: 'ready' }
  | { kind: 'refresh' | 'cancel' | 'preview' | 'logs' | 'export' | 'doctor' }
  | { kind: 'autoPreview'; value: boolean }
  | { kind: 'select' | 'navigate'; generation: number; key: string }
  | { kind: 'seek'; generation: number; time: number }
  | { kind: 'playback'; token: string; time: number; currentTime: number; sequence: number; seekSequence: number }
  | { kind: 'copyPoint'; token: string; x: number; y: number }
  | { kind: 'mediaError'; token: string; message: string };
