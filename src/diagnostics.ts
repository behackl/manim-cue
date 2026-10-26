import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from './process';

export interface PythonDiagnostic {
  status: 'ready' | 'limited' | 'missing-manim' | 'import-error' | 'unsupported-manim';
  python: string; python_version: string; prefix: string; base_prefix: string; cwd: string;
  manim_module: string | null; manim_version: string | null; error: string | null;
  capture_frame: boolean; timeline: boolean; video_encoder: boolean;
}

/** The state of a Python environment in one plain sentence. Details go to the log. */
export function diagnosticSummary(d: PythonDiagnostic): string {
  switch (d.status) {
    case 'ready': return 'Ready.';
    case 'missing-manim': return 'Manim is not installed in this Python environment. Run “Manim Cue: Set Up Python Environment” to install it.';
    case 'import-error': return 'Manim does not start in this Python environment. See the log for the error.';
    default: return 'This Manim version does not have the features Cue needs. Run “Manim Cue: Set Up Python Environment” to install the supported version.';
  }
}

export class RuntimeUnavailable extends Error {
  constructor(readonly diagnostic: PythonDiagnostic) { super(diagnosticSummary(diagnostic)); }
}

export async function readDiagnostic(file: string): Promise<PythonDiagnostic> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Same executable, environment and CWD as a scene run. No scene import. */
export async function checkPython(options: {
  python: string; env: NodeJS.ProcessEnv; cwd: string; helpers: string;
  signal: AbortSignal; log: (text: string) => void;
}): Promise<PythonDiagnostic> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-python-check-'));
  try {
    const destination = path.join(scratch, 'diagnostic.json');
    await runProcess(options.python, ['-B', '-X', `pycache_prefix=${path.join(scratch, 'bytecode')}`,
      path.join(options.helpers, 'support.py'), 'diagnose', destination], {
      ...options, env: { ...options.env, PYTHONIOENCODING: 'utf-8' }, timeout: 30000,
    });
    return await readDiagnostic(destination);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

const available = (value: boolean) => value ? 'available' : 'missing';
/** The complete result for the log. */
export function formatDiagnostic(d: PythonDiagnostic): string {
  return [
    `Python environment: ${diagnosticSummary(d)}`, `Python: ${d.python} (${d.python_version})`,
    `Environment: ${d.prefix}`, `Base Python: ${d.base_prefix}`, `Working folder: ${d.cwd}`,
    `Manim: ${d.manim_module ?? 'not installed'}${d.manim_version ? ` (version ${d.manim_version})` : ''}`,
    `Frames: ${available(d.capture_frame)}`, `Timeline: ${available(d.timeline)}`, `Video export: ${available(d.video_encoder)}`,
    ...d.error ? [d.error] : [],
  ].join('\n');
}
