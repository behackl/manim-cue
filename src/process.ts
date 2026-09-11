import { spawn } from 'node:child_process';

export class Cancelled extends Error { constructor() { super('Cancelled'); } }
export interface ProcessOptions {
  cwd: string; env?: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number;
  input?: string; log?: (text: string) => void;
  /** Appended to the timeout error; only callers whose timeout is configurable should set it. */
  timeoutHint?: string;
}
export function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<string> {
  if (options.signal.aborted) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', logged = 0, timedOut = false, cancelled = false, settled = false;
    const escalation: NodeJS.Timeout[] = [];
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          const task = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          task.on('error', () => child.kill());
        } else process.kill(-child.pid, signal);
      } catch { /* The owned process/group has already exited. */ }
    };
    const stop = () => {
      if (cancelled || settled) return;
      cancelled = true; kill('SIGINT');
      escalation.push(setTimeout(() => kill('SIGTERM'), 1800), setTimeout(() => kill('SIGKILL'), 2800),
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 3200));
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeout);
    options.signal.addEventListener('abort', stop, { once: true });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (cancelled) kill('SIGKILL');
      clearTimeout(timeout); escalation.forEach(clearTimeout);
      options.signal.removeEventListener('abort', stop);
      if (timedOut) reject(new Error(`Process exceeded ${options.timeout / 1000}s.${options.timeoutHint ? ` ${options.timeoutHint}` : ''}`));
      else if (cancelled) reject(new Cancelled());
      else if (error) reject(error);
      else resolve(output);
    };
    const consume = (text: string, stderr: boolean) => {
      if (stderr) errors = (errors + text).slice(-16000);
      else output = (output + text).slice(-128000);
      if (logged < 1024 * 1024) { options.log?.(text); logged += text.length; }
    };
    child.stdout.setEncoding('utf8').on('data', text => consume(text, false));
    child.stderr.setEncoding('utf8').on('data', text => consume(text, true));
    child.stdin.on('error', () => {}); // Early exits may close stdin before AST input is sent.
    child.stdin.end(options.input);
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`Process exited with code ${code}.\nExecutable: ${executable}\n${errors || output}`)));
    // Cancellation must also settle if an escaped descendant retained a stdout pipe.
    child.on('exit', () => { if (cancelled) finish(); });
  });
}
