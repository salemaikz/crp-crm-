// Кэш состояния лицензии на процесс: пересчёт (с записью часов в license_state) не чаще раза в минуту.
// Одновременные запросы ждут один пересчёт (single-flight). Сбой БД: прежний снимок живёт до 10 минут,
// дальше ошибка — без снимка доступ не решает «на глаз» (fail closed через 500, а не через «valid»).
import { getDb } from '../db';
import { licenseEnv } from './env';
import { refreshLicense, type LicenseSnapshot } from './service';

export const LICENSE_CACHE_TTL_MS = 60_000;
const STALE_LIMIT_MS = 10 * 60_000;

type Cache = { snap: LicenseSnapshot | null; at: number; inflight: Promise<LicenseSnapshot> | null };
type CacheGlobal = typeof globalThis & { __crmLicenseCache?: Cache };
const g = globalThis as CacheGlobal;

function cache(): Cache {
  g.__crmLicenseCache ??= { snap: null, at: 0, inflight: null };
  return g.__crmLicenseCache;
}

/** Монотонные часы процесса: перевод системных часов не ломает срок кэша. */
const mono = () => performance.now();

export async function currentLicenseSnapshot(): Promise<LicenseSnapshot> {
  const c = cache();
  if (c.snap && mono() - c.at < LICENSE_CACHE_TTL_MS) return c.snap;
  c.inflight ??= (async () => {
    try {
      const snap = await refreshLicense(await getDb(), licenseEnv());
      c.snap = snap;
      c.at = mono();
      return snap;
    } catch (err) {
      if (c.snap && mono() - c.at < STALE_LIMIT_MS) {
        const e = err as { name?: unknown; code?: unknown };
        console.error(JSON.stringify({ level: 'error', code: 'license_refresh_failed', name: e?.name, pg: e?.code ?? '' }));
        return c.snap;
      }
      throw err;
    } finally {
      c.inflight = null;
    }
  })();
  return c.inflight;
}

/** Следующий вызов пересчитает состояние (после установки лицензии, в тестах). */
export function invalidateLicenseCache(): void {
  g.__crmLicenseCache = undefined;
}
