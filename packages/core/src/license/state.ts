// Состояния лицензии (ARCHITECTURE §8.4, D-029, D-054, D-211).
// Подробное состояние хранится в license_state.state; доступ видит свёртку из пяти значений:
//   valid, expiring          → valid      всё работает (expiring — баннер администраторам, P10b)
//   expired                  → grace      срок прошёл, идёт льготный период: всё работает
//   invalid в льготе          → grace      лицензия выдана для прежней сборки (wrong_build): до builtAt + 7 сут
//                                         и не дальше срока подписанной копии в БД (D-290); строке
//                                         license_state (state, invalid_since, last_seen_at) льгота не верит
//   read_only                → read_only  мутации 423, кроме D-054; просмотр и выгрузка работают
//                                         (в том числе причина clock: часы позади дольше 48 ч, D-306, D-314;
//                                         и error: пересчёт на сервере не удался — не 500, D-314)
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
  /** Сохранённое состояние прошлой проверки; null — проверок ещё не было. Только для invalidSince (показ). */
  previous: LicenseStatus | null;
  /** license_state.invalid_since: только для показа «не сходится с», льготу не даёт и не продлевает (D-290). */
  invalidSince: number | null;
  /**
   * Последняя рабочая лицензия — копия license_raw, заново проверенная verifyStoredCopy; null — нет или не сходится.
   * Без неё льготы `wrong_build` нет, и льгота не идёт дальше её expiresAt + graceDays (D-290).
   */
  anchor: LicensePayload | null;
  /** Время сборки из водяного знака (Watermark.builtAt); null — льготы `wrong_build` нет (D-290). */
  builtAt: number | null;
  /** Отсутствие лицензии не блокирует (только общая сборка — missingAllowed). */
  allowMissing?: boolean;
  /** Часы позади дольше 48 ч (advanceClock locked, D-306): рабочая лицензия и льгота → «только чтение». */
  clockLocked?: boolean;
};

export type Evaluation = {
  status: LicenseStatus;
  access: LicenseAccess;
  /** Код причины для журнала и status: '' — всё хорошо; error — пересчёт не удался (сервер, D-314), в БД не пишется. */
  reason: InvalidReason | 'expired' | 'missing' | 'clock' | 'error' | '';
  invalidSince: number | null;
  license: LicensePayload | null;
  /** До какого момента работает льгота (expired или invalid после рабочей), иначе null. */
  graceUntil: number | null;
};

/** Лицензия не обязательна только в общей сборке без водяного знака клиента. */
export function missingAllowed(watermark: Watermark): boolean {
  return watermark.customer === null;
}

export function evaluateLicense(input: EvaluateInput): Evaluation {
  const e = evaluateVerdict(input);
  // Часы позади дольше 48 ч (D-306): работа и льгота — только после починки часов. Лицензии нет — как было
  if (!input.clockLocked || input.verdict === null || (e.access !== 'valid' && e.access !== 'grace')) return e;
  return { status: 'read_only', access: 'read_only', reason: 'clock', invalidSince: null, license: e.license, graceUntil: null };
}

function evaluateVerdict({ verdict, now, previous, invalidSince, anchor, builtAt, allowMissing = false }: EvaluateInput): Evaluation {
  if (verdict === null) {
    return { status: 'missing', access: allowMissing ? 'valid' : 'missing', reason: 'missing', invalidSince: null, license: null, graceUntil: null };
  }
  let reason: InvalidReason | null = verdict.ok ? null : verdict.reason;
  const license = verdict.ok ? verdict.license : null;
  if (license && now < license.notBefore) reason = 'not_yet_valid';

  if (reason !== null) {
    const until = reason === 'wrong_build' ? buildGraceUntil(now, anchor, builtAt) : null;
    // Начало несхождения — только для показа: прежнее, если и прошлая проверка была invalid
    const since = previous === 'invalid' && invalidSince !== null && invalidSince <= now ? invalidSince : now;
    return { status: 'invalid', access: until !== null ? 'grace' : 'invalid', reason, invalidSince: since, license, graceUntil: until };
  }

  const lic = license as LicensePayload;
  const graceEnd = lic.expiresAt + lic.graceDays * DAY_MS;
  if (now < lic.expiresAt - EXPIRING_DAYS * DAY_MS) return ok('valid', 'valid', lic, null);
  if (now < lic.expiresAt) return ok('expiring', 'valid', lic, null);
  if (now < graceEnd) return ok('expired', 'grace', lic, graceEnd);
  return { status: 'read_only', access: 'read_only', reason: 'expired', invalidSince: null, license: lic, graceUntil: null };
}

/**
 * Льгота для лицензии прежней сборки (`wrong_build`, D-211, D-290): обновили сборку, лицензию под новую ещё не
 * выдали. Считается только от вшитого и подписанного, строке license_state не верим:
 *  - конец — builtAt + 7 сут (время сборки из водяного знака ядра): правкой БД его не сдвинуть;
 *  - нужна подписанная копия рабочей лицензии этой установки в БД (anchor), и льгота не идёт дальше её
 *    expiresAt + graceDays; без копии (первая установка) и без builtAt (dev, старый образ) — льготы нет.
 * Остальные причины `invalid` (подпись, чужая установка, клиент, ключ, срок не начался) льготы не дают:
 * битый файл при рабочей копии сюда не доходит — сервер берёт вердикт по копии (src/server/platform/license).
 */
export function buildGraceUntil(now: number, anchor: LicensePayload | null, builtAt: number | null): number | null {
  if (anchor === null || builtAt === null || now < anchor.notBefore) return null;
  const until = Math.min(builtAt + INVALID_GRACE_DAYS * DAY_MS, anchor.expiresAt + anchor.graceDays * DAY_MS);
  return now < until ? until : null;
}

function ok(status: LicenseStatus, access: LicenseAccess, license: LicensePayload, graceUntil: number | null): Evaluation {
  return { status, access, reason: status === 'expired' ? 'expired' : '', invalidSince: null, license, graceUntil };
}

/** Признак модуля в лицензии (CONFIG §8): только при рабочей лицензии или в льготе. */
export function hasFeature(e: Pick<Evaluation, 'access' | 'license'>, feature: string): boolean {
  return (e.access === 'valid' || e.access === 'grace') && !!e.license && e.license.features.includes(feature);
}
