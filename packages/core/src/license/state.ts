// Состояния лицензии (ARCHITECTURE §8.4, D-029, D-054, D-211).
// Подробное состояние хранится в license_state.state; доступ видит свёртку из пяти значений:
//   valid, expiring          → valid      всё работает (expiring — баннер администраторам, P10b)
//   expired                  → grace      срок прошёл, идёт льготный период: всё работает
//   invalid в льготе 7 дней   → grace      лицензия перестала сходиться после рабочей (сборка, битый файл);
//                                         опора льготы — подписанная копия в БД (D-290), не строка license_state
//   read_only                → read_only  мутации 423, кроме D-054; просмотр и выгрузка работают
//   invalid                  → invalid    как read_only
//   missing                  → missing    как read_only
// Общая сборка без водяного знака (dev, тесты, e2e, общий образ CI) — исключение: лицензии нет → valid.
// Клиенту такая сборка не ставится (crmctl install, license install и update сверяют водяной знак ядра образа
// с клиентом установки), а загруженная
// лицензия проверяется в ней так же строго (D-211).
import { DAY_MS, type InvalidReason, type LicensePayload } from './format';
import type { Watermark } from './keys';
import type { Verdict } from './verify';

export const LICENSE_STATUSES = ['valid', 'expiring', 'expired', 'read_only', 'invalid', 'missing'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** Что видит доступ (src/server/access/types.ts LicenseState). */
export type LicenseAccess = 'valid' | 'grace' | 'read_only' | 'invalid' | 'missing';
export const LOCKING_ACCESS: ReadonlySet<LicenseAccess> = new Set<LicenseAccess>(['read_only', 'invalid', 'missing']);

export const EXPIRING_DAYS = 14;
export const INVALID_GRACE_DAYS = 7;

export type EvaluateInput = {
  /** null — лицензии нет (ни файла, ни копии в БД). */
  verdict: Verdict | null;
  /** Эффективное «сейчас» после правила часов. */
  now: number;
  /** Сохранённое состояние прошлой проверки; null — проверок ещё не было. */
  previous: LicenseStatus | null;
  /** Начало льготы `invalid` (license_state.invalid_since); null — льготы не было. Строке не доверяем (D-290). */
  invalidSince: number | null;
  /** license_state.last_seen_at до этой проверки: invalidSince раньше него на 7+ сут — не начало текущей льготы. */
  lastSeenAt: number | null;
  /**
   * Последняя рабочая лицензия — копия license_raw, заново проверенная verifyStoredCopy; null — нет или не сходится.
   * Без неё льготы `invalid` нет, и льгота не идёт дальше её expiresAt + graceDays (D-290).
   */
  anchor: LicensePayload | null;
  /** Отсутствие лицензии не блокирует (только общая сборка — missingAllowed). */
  allowMissing?: boolean;
};

export type Evaluation = {
  status: LicenseStatus;
  access: LicenseAccess;
  /** Код причины для журнала и status: '' — всё хорошо. */
  reason: InvalidReason | 'expired' | 'missing' | '';
  invalidSince: number | null;
  license: LicensePayload | null;
  /** До какого момента работает льгота (expired или invalid после рабочей), иначе null. */
  graceUntil: number | null;
};

const WORKING: ReadonlySet<LicenseStatus> = new Set<LicenseStatus>(['valid', 'expiring']);

/** Лицензия не обязательна только в общей сборке без водяного знака клиента. */
export function missingAllowed(watermark: Watermark): boolean {
  return watermark.customer === null;
}

export function evaluateLicense({ verdict, now, previous, invalidSince, lastSeenAt, anchor, allowMissing = false }: EvaluateInput): Evaluation {
  if (verdict === null) {
    return { status: 'missing', access: allowMissing ? 'valid' : 'missing', reason: 'missing', invalidSince: null, license: null, graceUntil: null };
  }
  let reason: InvalidReason | null = verdict.ok ? null : verdict.reason;
  const license = verdict.ok ? verdict.license : null;
  if (license && now < license.notBefore) reason = 'not_yet_valid';

  if (reason !== null) {
    const g = invalidGrace({ now, previous, invalidSince, lastSeenAt, anchor });
    return {
      status: 'invalid',
      access: g.until !== null ? 'grace' : 'invalid',
      reason,
      invalidSince: g.since,
      license,
      graceUntil: g.until,
    };
  }

  const lic = license as LicensePayload;
  const graceEnd = lic.expiresAt + lic.graceDays * DAY_MS;
  if (now < lic.expiresAt - EXPIRING_DAYS * DAY_MS) return ok('valid', 'valid', lic, null);
  if (now < lic.expiresAt) return ok('expiring', 'valid', lic, null);
  if (now < graceEnd) return ok('expired', 'grace', lic, graceEnd);
  return { status: 'read_only', access: 'read_only', reason: 'expired', invalidSince: null, license: lic, graceUntil: null };
}

/**
 * Льгота 7 дней для `invalid` (D-211, D-290). Строка license_state правится в обход crmctl, поэтому ей не верим:
 *  - опора — подписанная копия последней рабочей лицензии (anchor): её нет или её срок + graceDays прошёл —
 *    льготы нет, что бы ни стояло в state и invalid_since; льгота не выходит за этот срок;
 *  - invalid_since в будущем или раньше last_seen_at − 7 сут — подделка или давно кончившаяся льгота: не учитываем;
 *  - новая льгота начинается, только если прошлая проверка была рабочей (valid/expiring). Первая установка
 *    и `invalid` после `expired` — сразу «только чтение». Начало хранится: перезапуск льготу не продлевает.
 */
function invalidGrace(i: Pick<EvaluateInput, 'now' | 'previous' | 'invalidSince' | 'lastSeenAt' | 'anchor'>): {
  since: number | null;
  until: number | null;
} {
  const { now, anchor } = i;
  if (anchor === null || now < anchor.notBefore) return { since: null, until: null };
  const anchorEnd = anchor.expiresAt + anchor.graceDays * DAY_MS;
  if (now >= anchorEnd) return { since: null, until: null };
  const s = i.invalidSince;
  const stored = s !== null && i.lastSeenAt !== null && s <= now && s >= i.lastSeenAt - INVALID_GRACE_DAYS * DAY_MS ? s : null;
  const since = stored ?? (i.previous !== null && WORKING.has(i.previous) ? now : null);
  if (since === null) return { since: null, until: null };
  const until = Math.min(since + INVALID_GRACE_DAYS * DAY_MS, anchorEnd);
  return now < until ? { since, until } : { since, until: null };
}

function ok(status: LicenseStatus, access: LicenseAccess, license: LicensePayload, graceUntil: number | null): Evaluation {
  return { status, access, reason: status === 'expired' ? 'expired' : '', invalidSince: null, license, graceUntil };
}

/** Признак модуля в лицензии (CONFIG §8): только при рабочей лицензии или в льготе. */
export function hasFeature(e: Pick<Evaluation, 'access' | 'license'>, feature: string): boolean {
  return (e.access === 'valid' || e.access === 'grace') && !!e.license && e.license.features.includes(feature);
}
