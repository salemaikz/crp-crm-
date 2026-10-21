// Запуск воркера: проверка пояса, БД, цикл, остановка по SIGTERM/SIGINT.
import { time } from '@crm/core';
import { openScriptDb } from '../../src/server/platform/db';
import { createWorker } from '../../src/server/jobs/worker';
import { consoleJobLogger } from '../../src/server/jobs/deps';
import { checkRuntime, runtimeTamperMessage } from '../../src/server/platform/license/runtime';

const HOUR = 3_600_000;

/** Как у приложения (PROCESS 12.34): без данных часовых поясов Intl пояс установки посчитается неверно. */
export function assertAlmatyOffset(now: number = Date.now()): void {
  time.assertTimeZone('Asia/Almaty');
  if (time.utcOffsetMs(now, 'Asia/Almaty') !== 5 * HOUR) throw new Error('timezone_data_invalid');
}

export async function runWorkerProcess(): Promise<void> {
  assertAlmatyOffset();
  // Сборка клиента с явной предзагрузкой или инспектором не работает (D-312, D-314): до БД, выход с кодом 1 —
  // в index.ts; прочие отличия от поставки — сигнал в журнал и аудит
  const tamper = checkRuntime('worker');
  if (tamper.length > 0) {
    console.error(runtimeTamperMessage(tamper));
    throw new Error('runtime_tamper');
  }
  const close = await openScriptDb();
  const worker = createWorker();
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    consoleJobLogger.info('worker_stopping');
    await worker.stop();
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  consoleJobLogger.info('worker_started');
  worker.start();
}
