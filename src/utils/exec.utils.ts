/** Thin wrappers around `node:child_process` for running host commands. */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Run a command, capturing output. Never throws (spawn errors → non-zero exit). */
export async function exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const [file, ...args] = cmd;
  if (file === undefined) {
    throw new Error('exec called with an empty command');
  }
  return new Promise<ExecResult>(resolve => {
    const proc = spawn(file, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    // e.g. ENOENT for a missing binary: surface as a failed exit, not a throw.
    proc.on('error', error => resolve({ exitCode: 1, stdout, stderr: String(error) }));
    proc.on('close', code => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

/** Run a command, throwing a descriptive error on non-zero exit. */
export async function execOk(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const result = await exec(cmd, opts);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`\`${cmd.join(' ')}\` failed (exit ${result.exitCode})\n${output}`);
  }
  return result;
}

/**
 * Whether an executable is resolvable on the host PATH. Scans `$PATH` (honoring
 * `$PATHEXT` on Windows) — the same lookup `Bun.which` did, but stdlib-only so it
 * runs unchanged on both Node and Bun.
 */
export function toolExists(name: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const exts = isWindows ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const mode = isWindows ? constants.F_OK : constants.X_OK;
  return dirs.some(dir =>
    exts.some(ext => {
      try {
        accessSync(join(dir, `${name}${ext}`), mode);
        return true;
      } catch {
        return false;
      }
    })
  );
}
