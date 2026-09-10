import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from './process';

export interface PythonDiagnostic {
  status: 'ready' | 'limited' | 'missing-manim' | 'import-error' | 'unsupported-manim';
  python: string; python_version: string; prefix: string; base_prefix: string; cwd: string;
  manim_module: string | null; manim_version: string | null; error: string | null;
  capture_frame?: boolean; timeline?: boolean; video_encoder?: boolean;
}

export class RuntimeUnavailable extends Error {
  constructor(readonly diagnostic: PythonDiagnostic) {
    super(`Manim Cue: ${diagnostic.status} (${diagnostic.manim_version ?? 'unknown version'}). ${diagnostic.error ?? ''}\nRun Manim Cue: Check Python Environment or Select Python for Manim Cue, then Refresh.`);
  }
}

export async function readDiagnostic(file: string): Promise<PythonDiagnostic> {
  if ((await fs.stat(file)).size > 65536) throw new Error('Invalid environment diagnostic size.');
  const result = JSON.parse(await fs.readFile(file, 'utf8')) as PythonDiagnostic;
  if (!['ready', 'limited', 'missing-manim', 'import-error', 'unsupported-manim'].includes(result.status) || typeof result.python !== 'string') {
    throw new Error('Python returned an invalid environment diagnostic.');
  }
  return result;
}

/** Same executable, flags, environment and CWD as profile preparation. No scene import. */
export async function checkPython(options: {
  python: string; env: NodeJS.ProcessEnv; cwd: string; helpers: string;
  signal: AbortSignal; log: (text: string) => void;
}): Promise<PythonDiagnostic> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-python-check-'));
  try {
    const destination = path.join(scratch, 'diagnostic.json');
    await runProcess(options.python, ['-B', '-X', `pycache_prefix=${path.join(scratch, 'bytecode')}`,
      path.join(options.helpers, 'support.py'), 'diagnose', '-', destination], {
      ...options, env: { ...options.env, PYTHONIOENCODING: 'utf-8' }, timeout: 30000,
    });
    return await readDiagnostic(destination);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

export function formatDiagnostic(result: PythonDiagnostic): string {
  return [
    `Check: ${result.status}`, `Actual Python: ${result.python} (${result.python_version})`,
    `Environment prefix: ${result.prefix}`, `Base prefix: ${result.base_prefix}`,
    `Working directory: ${result.cwd}`, `Manim module: ${result.manim_module ?? '(not imported)'}`,
    `Manim version: ${result.manim_version ?? '(unknown)'}`,
    `Timeline / full preview: ${result.timeline ? 'available' : 'unavailable'}`,
    `Current-frame capture / comparison: ${result.capture_frame ? 'available' : 'unavailable'}`,
    `New MP4 export encoder profile: ${result.video_encoder ? 'available' : 'unavailable'}`,
    result.error ?? 'Required APIs available; scene-specific dependencies and native encoders are not checked.',
  ].join('\n');
}
