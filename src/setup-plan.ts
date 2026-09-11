import * as path from 'node:path';

export const SETUP_PYTHON = '3.13';
export const MANIM_BRANCH = 'refactor/manager-targeted-frame';
export const MANIM_ARCHIVE = `https://github.com/ManimCommunity/manim/archive/refs/heads/${MANIM_BRANCH}.zip`;
export const MANIM_REQUIREMENT = `manim @ ${MANIM_ARCHIVE}`;

export type SetupTool = { kind: 'uv'; executable: string } | { kind: 'python'; executable: string };
export interface SetupCommand { executable: string; args: string[] }

export function environmentExecutable(directory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.join(directory, 'Scripts', 'python.exe') : path.posix.join(directory, 'bin', 'python');
}

export function setupCommands(tool: SetupTool, directory: string, platform: NodeJS.Platform = process.platform): {
  create: SetupCommand; install: SetupCommand; python: string;
} {
  const python = environmentExecutable(directory, platform);
  if (tool.kind === 'uv') return {
    create: { executable: tool.executable, args: ['venv', '--python', SETUP_PYTHON, directory] },
    install: { executable: tool.executable, args: ['pip', 'install', '--python', python, '--refresh-package', 'manim', MANIM_REQUIREMENT] },
    python,
  };
  return {
    create: { executable: tool.executable, args: ['-m', 'venv', directory] },
    install: { executable: python, args: ['-m', 'pip', 'install', '--upgrade', '--no-cache-dir', MANIM_REQUIREMENT] },
    python,
  };
}
