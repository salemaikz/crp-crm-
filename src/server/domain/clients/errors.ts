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

/** 409 при вводе одного поля на месте: поле изменилось, пока его правили; несёт текущее значение этого поля. */
export class FieldConflictError extends DetailedConflictError {
  constructor(
    readonly key: string,
    readonly current: fields.FieldValue | null,
  ) {
    super('card_changed');
  }
}

/**
 * 409 при правке поля клиента на месте: несёт текущие значения только тех ключей запроса, что видны зрителю
 * (системные — всегда, поля настроек — после проекции по роли). Скрытое поле значения не получает.
 */
export class ClientFieldConflictError extends DetailedConflictError {
  constructor(readonly current: { system: Record<string, string | boolean | null>; custom: Record<string, fields.FieldValue | null> }) {
    super('client_changed');
  }
}
