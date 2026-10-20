// Задача воркера `license` (worker-design §6, ARCHITECTURE §7): при старте и раз в час пересчитать
// состояние, даже если в приложение никто не заходит (часы и переход в «только чтение» идут без запросов).
// Подключение: в src/server/jobs/platform.ts `licenseJob.handler = licenseJobHandler` (вместо заглушки).
import type { JobResult } from '../jobs';
import { getDb } from '../db';
import { invalidateLicenseCache } from './current';
import { licenseEnv } from './env';
import { refreshLicense } from './service';

export async function licenseJobHandler(): Promise<JobResult> {
  const snap = await refreshLicense(await getDb(), licenseEnv());
  invalidateLicenseCache();
  // В stats — только коды и числа (журнал контейнера, страница «Состояние»)
  return {
    status: 'ok',
    stats: { locked: snap.access === 'read_only' || snap.access === 'invalid' || snap.access === 'missing' ? 1 : 0 },
    note: `${snap.status}/${snap.access}${snap.reason ? `/${snap.reason}` : ''}${snap.clockJump !== 'none' ? `/clock_${snap.clockJump}` : ''}`,
  };
}
