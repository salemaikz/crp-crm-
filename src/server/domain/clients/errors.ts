// Ошибки полей: ответ 400 с ключами и кодами проблем (без значений).
import type { fields } from '@crm/core';

export class FieldIssuesError extends Error {
  override name = 'FieldIssuesError';
  constructor(readonly issues: readonly fields.FieldIssue[]) {
    super('fields');
  }
}
