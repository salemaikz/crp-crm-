// Ошибки настроек продаж: код доступа + машинный detail; для проверки — ещё пути без значений.
import { AccessError } from '@/server/access/errors';

/** Ревизия изменилась с момента, когда экран прочитал настройки: 409 `config_conflict`. */
export class SettingsConflictError extends AccessError {
  readonly detail = 'config_conflict';
  constructor() {
    super('conflict', 'conflict:config_conflict');
  }
}

/** Значения не прошли проверку: 400 `invalid` и пути (без значений — в них бывают номера и заметки). */
export class SettingsInvalidError extends AccessError {
  readonly detail = 'invalid';
  constructor(readonly issues: readonly { path: string }[]) {
    super('bad_request', 'bad_request:invalid');
  }
}

/** Нет пространства, в котором править (администратор без роли). */
export class SettingsNoSpaceError extends AccessError {
  readonly detail = 'no_space';
  constructor() {
    super('bad_request', 'bad_request:no_space');
  }
}
