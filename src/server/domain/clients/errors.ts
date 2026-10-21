// Ошибки полей: ответ 400 с ключами и кодами проблем (без значений).
import type { fields } from '@crm/core';
import { ConflictError } from '@/server/access';

export class FieldIssuesError extends Error {
  override name = 'FieldIssuesError';
  constructor(readonly issues: readonly fields.FieldIssue[]) {
    super('fields');
  }
}

/** 409 с машинным кодом для интерфейса (`pin_limit`, `card_changed`); без текстов и значений. */
export class DetailedConflictError extends ConflictError {
  constructor(readonly detail: string) {
    super();
  }
}
