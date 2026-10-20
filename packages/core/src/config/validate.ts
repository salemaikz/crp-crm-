// Проверка набора настроек целиком (схема + связи). Один вход для пресета, UI, CLI и миграций.
import { ConfigSetV1 } from './schema/v1.js';
import { formatPath } from './paths.js';

export type ConfigIssue = { path: string; message: string };

export type ConfigCheck = { ok: true; value: ConfigSetV1 } | { ok: false; issues: ConfigIssue[] };

/** `{ global, spaces: { <ключ>: doc } }` → проверенный набор или список ошибок с путями. */
export function validateConfigSet(input: unknown): ConfigCheck {
  const r = ConfigSetV1.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: formatPath(i.path.map(String)), message: i.message })),
  };
}

/** То же, но бросает ошибку с перечнем проблем (CLI, тесты пресетов). */
export function assertConfigSet(input: unknown): ConfigSetV1 {
  const r = validateConfigSet(input);
  if (r.ok) return r.value;
  throw new ConfigInvalidError(r.issues);
}

export class ConfigInvalidError extends Error {
  override name = 'ConfigInvalidError';
  constructor(readonly issues: ConfigIssue[]) {
    super(`настройки не прошли проверку:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  }
}
