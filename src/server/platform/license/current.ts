// Кэш состояния лицензии на процесс: пересчёт (с записью часов в license_state) не чаще раза в минуту.
// Одновременные запросы ждут один пересчёт (single-flight).
// Честная установка никогда не получает 500 из-за лицензии (D-314, D-054): любая ошибка пересчёта (БД, разбор,
// исключение) — не исключение, а вердикт. Прежний удачный снимок живёт до 10 минут (короткий сбой БД не запирает
// работу), дальше — «только чтение» с причиной error: просмотр, полная выгрузка и мутации безопасности работают,
// остальные мутации — 423. Повторный пересчёт после сбоя — не чаще раза в RETRY_MS.
import type { LicenseSnapshot } from './service';
import { getDb } from '../db';
import { licenseEnv } from './env';
import { refreshLicense } from './service';

export const LICENSE_CACHE_TTL_MS = 60_000;
const STALE_LIMIT_MS = 10 * 60_000;
const RETRY_MS = 5_000;

type Cache = {
  /** Последний удачный снимок и когда он получен (монотонное время процесса). */
  snap: LicenseSnapshot | null;
  at: number;
  /** Вердикт после сбоя и когда он выдан; пока свеж — не пересчитываем на каждый запрос. */
  failed: LicenseSnapshot | null;
  failedAt: number;
  inflight: Promise<LicenseSnapshot> | null;
};
type CacheGlobal = typeof globalThis & { __crmLicenseCache?: Cache };
const g = globalThis as CacheGlobal;

function cache(): Cache {
  g.__crmLicenseCache ??= { snap: null, at: 0, failed: null, failedAt: 0, inflight: null };
  return g.__crmLicenseCache;
}

/** Монотонные часы процесса: перевод системных часов не ломает срок кэша. */
const mono = () => performance.now();

/** «Только чтение» без лицензии и без записи в БД: пересчёт не удался. */
export function failedLicenseSnapshot(now: number): LicenseSnapshot {
  return {
    status: 'read_only',
    access: 'read_only',
    reason: 'error',
    invalidSince: null,
    license: null,
    graceUntil: null,
    installId: '',
    now,
    clockJump: 'none',
    source: 'none',
    fileReason: null,
  };
}

/** Только коды: имя класса ошибки и код Postgres/ОС, без текста (в нём бывают пути и значения). */
function logFailure(err: unknown, verdict: 'stale' | 'read_only'): void {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name.slice(0, 40) : 'unknown';
  const code = typeof e?.code === 'string' && /^[A-Z0-9_]{1,16}$/i.test(e.code) ? e.code : '';
  console.error(JSON.stringify({ level: 'error', code: 'license_refresh_failed', name, pg: code, verdict }));
}

export async function currentLicenseSnapshot(): Promise<LicenseSnapshot> {
  const c = cache();
  const t = mono();
  if (c.snap && t - c.at < LICENSE_CACHE_TTL_MS) return c.snap;
  if (c.failed && t - c.failedAt < RETRY_MS) return c.failed;
  c.inflight ??= (async () => {
    try {
      const snap = await refreshLicense(await getDb(), licenseEnv());
      c.snap = snap;
      c.at = mono();
      c.failed = null;
      return snap;
    } catch (err) {
      if (c.snap && mono() - c.at < STALE_LIMIT_MS) {
        logFailure(err, 'stale');
        return c.snap;
      }
      logFailure(err, 'read_only');
      c.failed = failedLicenseSnapshot(safeClock());
      c.failedAt = mono();
      return c.failed;
    } finally {
      c.inflight = null;
    }
  })();
  return c.inflight;
}

/** Часы для снимка сбоя: и окружение проверки могло не собраться. */
function safeClock(): number {
  try {
    return Math.floor(licenseEnv().clock());
  } catch {
    return Math.floor(Date.now());
  }
}

/** Следующий вызов пересчитает состояние (после установки лицензии, в тестах). */
export function invalidateLicenseCache(): void {
  g.__crmLicenseCache = undefined;
}
