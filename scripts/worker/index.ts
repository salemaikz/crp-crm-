// Воркер фоновых задач: dist/worker.mjs (Dockerfile). `--health` — проверка живости для healthcheck контейнера.
import { statSync } from 'node:fs';
import { WORKER_ALIVE_FILE, WORKER_ALIVE_MAX_AGE_MS } from '../../src/server/platform/jobs/types';

/** exit 0, если файл живости свежее WORKER_ALIVE_MAX_AGE_MS. */
export function isAlive(file: string = WORKER_ALIVE_FILE, now: number = Date.now()): boolean {
  try {
    return now - statSync(file).mtimeMs < WORKER_ALIVE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--health')) {
    process.exit(isAlive() ? 0 : 1);
  }
  const { runWorkerProcess } = await import('./run');
  await runWorkerProcess();
}

// Запуск только как точка входа (тесты импортируют isAlive)
if (process.argv[1] && /worker(\.mjs|[/\\]index\.ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(JSON.stringify({ level: 'error', code: 'worker_fatal', name: (e as { name?: string } | null)?.name ?? 'error' }));
    process.exit(1);
  });
}
