// Ошибки домена передач и их HTTP-представление (docs/deals-handoffs-design.md §6).
// «Не найдено» домен бросает как NotFoundError доступа; маршруты превращают ошибки в ответ (src/app/api/handoffs/_lib.ts).
import type { HandoffDomainErrorCode } from './types';

/** HTTP-статус кода: плохой ввод — 400, отказ состояния — 409. */
export const HANDOFF_HTTP_STATUS: Readonly<Record<HandoffDomainErrorCode, 400 | 409>> = {
  already_handled: 409,
  not_team_member: 400,
  reason_required: 400,
};

export class HandoffDomainError extends Error {
  readonly code: HandoffDomainErrorCode;

  constructor(code: HandoffDomainErrorCode) {
    super(code);
    this.name = 'HandoffDomainError';
    this.code = code;
  }

  get status(): 400 | 409 {
    return HANDOFF_HTTP_STATUS[this.code];
  }
}

export function isHandoffDomainError(e: unknown): e is HandoffDomainError {
  return e instanceof HandoffDomainError || (e instanceof Error && e.name === 'HandoffDomainError' && 'code' in e);
}
