// Ошибки домена сделок и их HTTP-представление (docs/deals-handoffs-design.md §6).
// Домен бросает DealDomainError (или CardRejectedError — отказ машины карточки); маршруты превращают их
// в ответ (src/app/api/deals/_lib.ts). «Не найдено» домен бросает как NotFoundError доступа.
import type { DealDomainErrorCode } from './types';

/** HTTP-статус кода: плохой ввод — 400, отказ состояния — 409. */
export const DEAL_HTTP_STATUS: Readonly<Record<DealDomainErrorCode, 400 | 409>> = {
  deal_closed: 409,
  deal_not_won: 409,
  outcome_required: 409,
  request_reused: 409,
  service_type_unknown: 400,
  amount_invalid: 400,
  won_at_invalid: 400,
  stage_unknown: 400,
  use_purchase: 400,
  use_lose: 400,
  next_step_required: 409,
  stage_fields_required: 409,
  stage_restricted: 409,
  reason_unknown: 400,
  reason_text_required: 400,
  service_type_locked: 409,
  invalid_settings: 409,
};

export class DealDomainError extends Error {
  readonly code: DealDomainErrorCode;
  /** Только у `stage_fields_required`: ключи незаполненных требований этапа. */
  readonly fields?: string[];

  constructor(code: DealDomainErrorCode, fields?: string[]) {
    super(code);
    this.name = 'DealDomainError';
    this.code = code;
    if (fields) this.fields = fields;
  }

  get status(): 400 | 409 {
    return DEAL_HTTP_STATUS[this.code];
  }
}

export function isDealDomainError(e: unknown): e is DealDomainError {
  return e instanceof DealDomainError || (e instanceof Error && e.name === 'DealDomainError' && 'code' in e);
}

/** Машина карточки отказала событию сделки (D-248): действие откатывается целиком, 409 с кодом ядра. */
export class CardRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CardRejectedError';
  }
}
