// Состояния лицензии (ARCHITECTURE §8.4, D-029, D-054, D-211).
// Подробное состояние хранится в license_state.state; доступ видит свёртку из пяти значений:
//   valid, expiring          → valid      всё работает (expiring — баннер администраторам, P10b)
//   expired                  → grace      срок прошёл, идёт льготный период: всё работает
//   invalid в льготе 7 дней   → grace      лицензия перестала сходиться после рабочей (сборка, ротация kid)
//   read_only                → read_only  мутации 423, кроме D-054; просмотр и выгрузка работают
//   invalid                  → invalid    как read_only
//   missing                  → missing    как read_only
// Общая сборка без водяного знака (dev, тесты, e2e, общий образ CI) — исключение: лицензии нет → valid.
// Клиенту такая сборка не ставится (crmctl сверяет водяной знак ядра с клиентом установки), а загруженная
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
  /** Начало льготы `invalid` (license_state.invalid_since); null — льготы не было. */
  invalidSince: number | null;
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

export function evaluateLicense({ verdict, now, previous, invalidSince, allowMissing = false }: EvaluateInput): Evaluation {
  if (verdict === null) {
    return { status: 'missing', access: allowMissing ? 'valid' : 'missing', reason: 'missing', invalidSince: null, license: null, graceUntil: null };
  }
  let reason: InvalidReason | null = verdict.ok ? null : verdict.reason;
  const license = verdict.ok ? verdict.license : null;
  if (license && now < license.notBefore) reason = 'not_yet_valid';

  if (reason !== null) {
    // Льгота 7 дней — только если до этого лицензия работала (valid/expiring). Начало льготы хранится,
    // поэтому перезапуск и повторные проверки её не продлевают. Первая установка — сразу «только чтение».
    const since = invalidSince ?? (previous !== null && WORKING.has(previous) ? now : null);
    const until = since === null ? null : since + INVALID_GRACE_DAYS * DAY_MS;
    const inGrace = until !== null && now < until;
    return { status: 'invalid', access: inGrace ? 'grace' : 'invalid', reason, invalidSince: since, license, graceUntil: inGrace ? until : null };
  }

  const lic = license as LicensePayload;
  const graceEnd = lic.expiresAt + lic.graceDays * DAY_MS;
  if (now < lic.expiresAt - EXPIRING_DAYS * DAY_MS) return ok('valid', 'valid', lic, null);
  if (now < lic.expiresAt) return ok('expiring', 'valid', lic, null);
  if (now < graceEnd) return ok('expired', 'grace', lic, graceEnd);
  return { status: 'read_only', access: 'read_only', reason: 'expired', invalidSince: null, license: lic, graceUntil: null };
}

function ok(status: LicenseStatus, access: LicenseAccess, license: LicensePayload, graceUntil: number | null): Evaluation {
  return { status, access, reason: status === 'expired' ? 'expired' : '', invalidSince: null, license, graceUntil };
}

/** Признак модуля в лицензии (CONFIG §8): только при рабочей лицензии или в льготе. */
export function hasFeature(e: Pick<Evaluation, 'access' | 'license'>, feature: string): boolean {
  return (e.access === 'valid' || e.access === 'grace') && !!e.license && e.license.features.includes(feature);
}
