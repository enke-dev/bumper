/** Child processes whose output is consumed line by line while they run (the manage log). */
import { spawn } from 'node:child_process';

export type OutputStream = 'stdout' | 'stderr';

export interface StreamOptions {
  cwd: string;
  env?: Record<string, string>;
  onLine: (stream: OutputStream, line: string) => void;
}

/** Run a command, streaming its output; resolves to the exit code (1 when it can't spawn). */
export type StreamExec = (cmd: string[], options: StreamOptions) => Promise<number>;

/** Split a chunk stream into lines, flushing a trailing partial line at the end. */
function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; end(): void } {
  const state = { rest: '' };
  return {
    push(chunk) {
      const parts = `${state.rest}${chunk}`.split(/\r?\n/);
      state.rest = parts.pop() ?? '';
      parts.forEach(emit);
    },
    end() {
      if (state.rest !== '') {
        emit(state.rest);
        state.rest = '';
      }
    },
  };
}

export const streamExec: StreamExec = (cmd, { cwd, env, onLine }) => {
  const [file, ...args] = cmd;
  if (file === undefined) {
    throw new Error('streamExec called with an empty command');
  }
  return new Promise<number>(resolve => {
    const proc = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = lineSplitter(line => onLine('stdout', line));
    const err = lineSplitter(line => onLine('stderr', line));
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => out.push(chunk));
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => err.push(chunk));
    proc.on('error', error => {
      err.end();
      onLine('stderr', String(error));
      resolve(1);
    });
    proc.on('close', code => {
      out.end();
      err.end();
      resolve(code ?? 0);
    });
  });
};

/** Wrap a free-form command line for the platform shell. */
export function shellCommand(command: string): string[] {
  return process.platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command];
}
