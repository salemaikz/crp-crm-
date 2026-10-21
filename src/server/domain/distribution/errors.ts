// Ошибки домена раздачи и их HTTP-представление (docs/distribution-design.md §6).
import { DISTRIBUTION_ERRORS, type DistributionErrorCode, type DistributionFailure } from './types';

/** HTTP-статус кода: `not_participant` и `dates` — плохой запрос, остальное — конфликт состояния. */
export const DISTRIBUTION_HTTP_STATUS: Readonly<Record<DistributionErrorCode, number>> = {
  not_working: 409,
  over_cap: 409,
  mode_off: 409,
  invalid_settings: 409,
  not_participant: 400,
  overlap: 409,
  substitute_absent: 409,
  no_substitute: 409,
  dates: 400,
};

export class DistributionDomainError extends Error implements DistributionFailure {
  readonly code: DistributionErrorCode;
  readonly remaining?: number;
  readonly cap?: number;

  constructor(code: DistributionErrorCode, extra: { remaining?: number; cap?: number } = {}) {
    super(code);
    this.name = 'DistributionDomainError';
    this.code = code;
    if (extra.remaining !== undefined) this.remaining = extra.remaining;
    if (extra.cap !== undefined) this.cap = extra.cap;
  }

  get status(): number {
    return DISTRIBUTION_HTTP_STATUS[this.code];
  }
}

export function isDistributionDomainError(e: unknown): e is DistributionDomainError {
  return (
    e instanceof DistributionDomainError ||
    (e instanceof Error && e.name === 'DistributionDomainError' && (DISTRIBUTION_ERRORS as readonly unknown[]).includes((e as { code?: unknown }).code))
  );
}

/** Тело ответа: код (и «осталось N из M» для `over_cap`). Текст — на стороне интерфейса по `messages`. */
export function failureBody(e: DistributionFailure): { error: DistributionErrorCode; remaining?: number; cap?: number } {
  const body: { error: DistributionErrorCode; remaining?: number; cap?: number } = { error: e.code };
  if (e.remaining !== undefined) body.remaining = e.remaining;
  if (e.cap !== undefined) body.cap = e.cap;
  return body;
}
