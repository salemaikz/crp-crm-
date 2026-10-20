// Ошибки доступа и единые ответы. Домен бросает эти ошибки, обёртки route()/page()/action()
// превращают их в один и тот же ответ. «Чужое = несуществующее» (D-017): 404 для чужого объекта
// совпадает байт в байт с 404 для несуществующего id, текстов с подробностями нет.

export type AccessErrorCode = 'unauthorized' | 'not_found' | 'forbidden' | 'read_only' | 'conflict' | 'bad_request';

export const HTTP_STATUS: Readonly<Record<AccessErrorCode | 'internal', number>> = {
  unauthorized: 401,
  not_found: 404,
  forbidden: 403,
  read_only: 423,
  conflict: 409,
  bad_request: 400,
  internal: 500,
};

/** Базовая ошибка доступа: код без текста. Сообщение — только для логов разработчика, без ПДн. */
export class AccessError extends Error {
  constructor(
    readonly code: AccessErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

/** Нет сессии или учётка отключена. */
export class UnauthorizedError extends AccessError {
  constructor() {
    super('unauthorized');
  }
}

/** Объекта нет или он чужой — ответ одинаковый. */
export class NotFoundError extends AccessError {
  constructor() {
    super('not_found');
  }
}

/** Нет права на раздел (не на объект). */
export class ForbiddenError extends AccessError {
  constructor() {
    super('forbidden');
  }
}

/** Мутация запрещена: роль «только чтение» или лицензия не даёт менять данные (423). */
export class ReadOnlyError extends AccessError {
  constructor() {
    super('read_only');
  }
}

/** Объект виден, но изменился (версия): 409 «карточка изменилась». */
export class ConflictError extends AccessError {
  constructor() {
    super('conflict');
  }
}

/** Неверный запрос. `detail` — машинный код для интерфейса (например, 'hidden_field_filter'). */
export class BadRequestError extends AccessError {
  constructor(readonly detail: string = 'invalid') {
    super('bad_request');
  }
}

export function isAccessError(e: unknown): e is AccessError {
  return e instanceof AccessError;
}

/** Тело ответа API для кода ошибки. Одинаковое для всех причин одного кода. */
export function errorBody(code: AccessErrorCode | 'internal', detail?: string): { error: string; detail?: string } {
  return detail ? { error: code, detail } : { error: code };
}
