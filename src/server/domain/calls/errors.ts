// Ошибки домена обзвона и их HTTP-представление (docs/calls-design.md §11).
// Домен бросает CallsDomainError; маршруты превращают её в ответ (src/app/api/calls/_lib.ts).
import type { CallsErrorCode, CallsFailure } from './types';

/** Коды «плохой запрос» (400): проверки ядра и домена, которые оператор может исправить в шторке. */
export const BAD_REQUEST_CODES: ReadonlySet<CallsErrorCode> = new Set<CallsErrorCode>([
  'reason_required',
  'lpr_required',
  'lpr_info_required',
  'callback_at_required',
  'callback_in_past',
  'contact_required',
  'agreement_required',
  'phone_required',
  'outcome_unknown',
  'outcome_archived',
  'field_not_allowed',
  'phone_not_on_card',
  'fields',
]);

/** Коды «не найдено»: ответ байт в байт как у несуществующего (D-017). */
const NOT_FOUND_CODES: ReadonlySet<CallsErrorCode> = new Set<CallsErrorCode>(['not_found', 'opid_reused']);

const CONFLICT_CODES: ReadonlySet<CallsErrorCode> = new Set<CallsErrorCode>(['skip_limit', 'invalid_transition']);

export class CallsDomainError extends Error implements CallsFailure {
  readonly code: CallsErrorCode;
  readonly field: string | null;
  /** Подробности для тела ответа (например, `skipLimit`). */
  readonly extra: Readonly<Record<string, number | string>>;

  constructor(code: CallsErrorCode, field: string | null = null, extra: Readonly<Record<string, number | string>> = {}) {
    super(code);
    this.name = 'CallsDomainError';
    this.code = code;
    this.field = field;
    this.extra = extra;
  }
}

export function isCallsDomainError(e: unknown): e is CallsDomainError {
  return e instanceof CallsDomainError || (e instanceof Error && e.name === 'CallsDomainError' && 'code' in e);
}

export type CallsHttpFailure =
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'response'; status: number; body: Record<string, unknown> };

/** Что отдать на ошибку домена (таблица §11). */
export function httpFailure(e: CallsDomainError): CallsHttpFailure {
  if (NOT_FOUND_CODES.has(e.code)) return { kind: 'not_found' };
  if (e.code === 'forbidden') return { kind: 'forbidden' };
  if (BAD_REQUEST_CODES.has(e.code)) return { kind: 'response', status: 400, body: { error: 'bad_request', code: e.code, field: e.field } };
  if (CONFLICT_CODES.has(e.code)) return { kind: 'response', status: 409, body: { error: e.code, ...e.extra } };
  if (e.code === 'invalid_settings') return { kind: 'response', status: 409, body: { error: 'invalid_settings' } };
  // Остальные отказы ядра для итога и пропуска (stale, version_conflict и др.) — конфликт с кодом.
  return { kind: 'response', status: 409, body: { error: 'conflict', code: e.code } };
}
