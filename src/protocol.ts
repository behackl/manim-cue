import type { ExportChoice, ExportModel } from './export-settings';
import type { Timeline } from './timeline';
import type { TimeRange } from './selection';

/** A result file for a webview. `id` is the file path; `frame` is the frame size in scene units. */
interface Media { id: string; uri: string; outdated: boolean; frame: { width: number; height: number } }
/** `time` is the start of the frame, or null for the last frame when the scene ends before `requestedTime`. */
export interface FrameMedia extends Media { requestedTime: number; time: number | null }
/** A video in scene time: `duration` includes the `skipped` parts that the file leaves out. */
export interface VideoMedia extends Media { duration: number; rate: number; skipped: TimeRange[] }

export interface Model {
  scene: string;
  /** The file and the scene class: another key is another scene, also with the same class name. */
  sceneKey: string;
  status: string; busy: boolean; error?: string;
  /** The error comes from the Python environment. */
  pythonProblem: boolean;
  /** "Render Video Automatically" is on. */
  autoRender: boolean; fps: number; profile?: string;
  /** "Render video" or Play asked for a video that is not there yet. */
  videoWanted: boolean;
  /** The current job; frames can be made only while there is one. */
  job?: string;
  /** The last position. A new webview starts here. */
  time: number;
  /** The timeline, only for the timeline view and only when `timelineId` changes. */
  timeline?: Timeline;
  timelineId?: string;
  /** The selection of the timeline stays while this key stays: a render keeps the entries of the inspection. */
  timelineKey?: string;
  /** The duration of the scene, from the timeline. */
  duration?: number;
  timelineOutdated: boolean;
  frame?: FrameMedia; video?: VideoMedia;
  /** The comparison reference. */
  reference?: FrameMedia;
  /** The plays to loop, from the timeline view. */
  loop?: TimeRange;
  exportState?: ExportModel;
}
export type HostMessage =
  | { kind: 'state'; model: Model }
  /** To the preview: the timeline view chose a time. */
  | { kind: 'seek'; time: number }
  | { kind: 'step'; direction: -1 | 1 }
  /** To the timeline view: the preview moved. */
  | { kind: 'position'; time: number };
export type ViewMessage =
  | { kind: 'ready' }
  | { kind: 'refresh' | 'cancel' | 'preview' | 'logs' | 'export' | 'doctor' | 'settings' }
  | { kind: 'seek'; time: number }
  | { kind: 'loop'; range?: TimeRange }
  | { kind: 'navigate'; index: number }
  | { kind: 'position'; time: number }
  | { kind: 'frameNeeded'; time: number }
  | { kind: 'pin'; id: string }
  | { kind: 'copyPoint'; x: number; y: number }
  | { kind: 'openExport'; time: number; video: boolean }
  | { kind: 'closeExport'; id: string }
  | { kind: 'submitExport'; id: string; choice: ExportChoice }
  | { kind: 'cancelExport' };
