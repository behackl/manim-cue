import * as path from 'node:path';

export const SETUP_PYTHON = '3.13';
export const MANIM_VERSION = '0.30.0a1';
const MANIM_REQUIREMENT = `manim==${MANIM_VERSION}`;

export type SetupTool = { kind: 'uv'; executable: string } | { kind: 'python'; executable: string };
export interface SetupCommand { executable: string; args: string[] }

const ENVIRONMENT_SEGMENTS = new Set(['.venv', 'site-packages']);

/** Installing packages writes thousands of files that never affect a scene's own dependencies. */
export function insideEnvironment(fsPath: string): boolean {
  return fsPath.split(/[\\/]/u).some(segment => ENVIRONMENT_SEGMENTS.has(segment));
}

export function environmentExecutable(directory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.join(directory, 'Scripts', 'python.exe') : path.posix.join(directory, 'bin', 'python');
}

export function setupCommands(tool: SetupTool, directory: string, platform: NodeJS.Platform = process.platform): {
  create: SetupCommand; install: SetupCommand; python: string;
} {
  const python = environmentExecutable(directory, platform);
  if (tool.kind === 'uv') return {
    create: { executable: tool.executable, args: ['venv', '--python', SETUP_PYTHON, directory] },
    install: { executable: tool.executable, args: ['pip', 'install', '--python', python, MANIM_REQUIREMENT] },
    python,
  };
  return {
    create: { executable: tool.executable, args: ['-m', 'venv', directory] },
    install: { executable: python, args: ['-m', 'pip', 'install', MANIM_REQUIREMENT] },
    python,
  };
}
