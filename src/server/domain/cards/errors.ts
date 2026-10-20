// Ошибки ручных переходов карточки (docs/tasks-team-design.md §1.1) и их HTTP-представление.
import type { calling } from '@crm/core';

/** Код отказа ядра, который ручное действие превращает в ошибку. */
export type CardActionCode = calling.RejectCode;

export class CardActionError extends Error {
  readonly code: CardActionCode;
  readonly field: string | null;
  /** Актуальная версия карточки для `version_conflict` (интерфейс перечитывает карточку). */
  readonly version: number | null;

  constructor(code: CardActionCode, field: string | null = null, version: number | null = null) {
    super(code);
    this.name = 'CardActionError';
    this.code = code;
    this.field = field;
    this.version = version;
  }

  /** version_conflict → 409 card_changed; invalid_transition → 409 invalid_state; обязательные поля и неактивный получатель → 400. */
  get status(): 400 | 409 {
    return this.code === 'version_conflict' || this.code === 'invalid_transition' ? 409 : this.code === 'stale' ? 409 : 400;
  }

  get body(): { error: string; field?: string; version?: number } {
    const error = this.code === 'version_conflict' ? 'card_changed' : this.code === 'invalid_transition' ? 'invalid_state' : this.code;
    return { error, ...(this.field ? { field: this.field } : {}), ...(this.version !== null ? { version: this.version } : {}) };
  }
}

export function isCardActionError(e: unknown): e is CardActionError {
  return e instanceof CardActionError || (e instanceof Error && e.name === 'CardActionError' && 'code' in e);
}
