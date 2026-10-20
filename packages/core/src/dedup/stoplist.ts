// Стоп-лист (PROCESS 2.3 п. 2, D-021, D-052): в базе хранится только HMAC номера. Функция хэширования
// внедряется (ключ `CRM_PHONE_HMAC_KEY` ядру неизвестен), поэтому ядро остаётся чистым.

/** `digits` (канон `7XXXXXXXXXX`) → HMAC-строка. Синхронная: сервер считает HMAC-SHA256 из node:crypto. */
export type HashFn = (value: string) => string;

/** Набор HMAC стоп-листа: `ReadonlySet<string>` или обёртка над предзагруженной выборкой. */
export interface StopListLookup {
  has(hash: string): boolean;
}

export type StopListVerdict =
  /** Рабочие номера есть, стоп-листовых нет или остались другие рабочие: идём дальше по правилам. */
  | 'ok'
  /** Рабочие номера были, но все в стоп-листе: запись не создаётся, данные не сохраняются. */
  | 'stop_list'
  /** Рабочих номеров не было вовсе: это правило 5 (пул «Без рабочего номера»), а не стоп-лист. */
  | 'no_working_phone';

export interface StopListResult {
  verdict: StopListVerdict;
  /** Рабочие номера не из стоп-листа. */
  allowed: string[];
  /** Номера из стоп-листа: отбрасываются, в карточку не попадают. */
  stopped: string[];
}

/** Применить стоп-лист к рабочим номерам записи. Номер из стоп-листа отбрасывается; если остался хотя бы один — запись идёт дальше (D-021). */
export function applyStopList(
  workingPhones: readonly string[],
  hash: HashFn,
  stopList: StopListLookup,
): StopListResult {
  const allowed: string[] = [];
  const stopped: string[] = [];
  for (const p of new Set(workingPhones)) (stopList.has(hash(p)) ? stopped : allowed).push(p);
  if (allowed.length > 0) return { verdict: 'ok', allowed, stopped };
  return { verdict: stopped.length > 0 ? 'stop_list' : 'no_working_phone', allowed, stopped };
}
