// Боевой исполнитель команд: child_process.spawn, без оболочки (аргументы не склеиваются в строку).
import { spawn } from 'node:child_process';
import type { Executor, RunOptions, RunResult } from './types';

export const realExecutor: Executor = {
  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.on('error', () => {}); // команда могла закрыть stdin раньше времени
      child.stdin.end(opts.input ?? '');
    });
  },
};
