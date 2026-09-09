import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess } from './process';

export interface PythonDiagnostic {
  status: 'ready' | 'missing-manim' | 'import-error' | 'unsupported-manim';
  python: string; python_version: string; prefix: string; base_prefix: string; cwd: string;
  manim_module: string | null; manim_version: string | null; error: string | null;
  capture_frame?: boolean; timeline?: boolean;
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
    const result = JSON.parse(await fs.readFile(destination, 'utf8')) as PythonDiagnostic;
    if (!['ready', 'missing-manim', 'import-error', 'unsupported-manim'].includes(result.status) || typeof result.python !== 'string') {
      throw new Error('Python returned an invalid environment diagnostic.');
    }
    return result;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

export function formatDiagnostic(result: PythonDiagnostic): string {
  return [
    `Check: ${result.status}`, `Actual Python: ${result.python} (${result.python_version})`,
    `Environment prefix: ${result.prefix}`, `Base prefix: ${result.base_prefix}`,
    `Working directory: ${result.cwd}`, `Manim module: ${result.manim_module ?? '(not imported)'}`,
    `Manim version: ${result.manim_version ?? '(unknown)'}`,
    `Current-frame capture: ${result.capture_frame ? 'available' : 'requires Manager.capture_frame_at; full preview remains available with timeline support'}`,
    result.error ?? 'Timeline evaluation API available.',
  ].join('\n');
}
