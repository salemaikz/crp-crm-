// Ошибки выгрузок (R3b): код без текста (текст — messages/ru/reports.json). В лог и аудит — только код.
import { AccessError } from '@/server/access/errors';

/** Повторный пароль полной выгрузки неверен: 403 `password_invalid` (аудит не пишется, D-264). */
export class PasswordInvalidError extends AccessError {
  readonly detail = 'password_invalid';
  constructor() {
    super('forbidden', 'forbidden:password_invalid');
  }
}

/** Причины 429: лимит попыток пароля, лимит полных выгрузок в сутки, уже идёт другая полная выгрузка. */
export type ExportLimitCode = 'rate_limited' | 'export_limit' | 'busy';

export class ExportLimitError extends Error {
  constructor(
    readonly code: ExportLimitCode,
    readonly retryAfterSec: number | null = null,
  ) {
    super(`export:${code}`);
    this.name = 'ExportLimitError';
  }
}

/** Строк больше, чем помещается в книгу XLSX: 413 `too_many_rows`. */
export class ExportTooLargeError extends Error {
  readonly code = 'too_many_rows';
  constructor() {
    super('export:too_many_rows');
    this.name = 'ExportTooLargeError';
  }
}
