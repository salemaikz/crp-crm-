// crmctl secrets rotate [--check] (INTEGRATIONS §7, D-269, O5): перешифровать секреты интеграций текущим ключом.
// Порядок ротации: новый CRM_SECRETS_KEY_<kid> и CRM_SECRETS_KID в app.env (старый ключ остаётся) → перезапуск →
// `crmctl secrets rotate` → `crmctl secrets rotate --check` → старый ключ удаляет владелец.
// Печатаются только числа: ни значений, ни имён интеграций. Коды выхода: 0 — успех; 1 — ошибка или не всё открылось.
// Отдельный файл, а не secrets.ts: тот входит в хостовую копию crmctl (install), а этой команде нужны БД и ключи образа.
import { getDb, openScriptDb } from '../../src/server/platform/db';
import { checkSecrets, isSecretError, loadKeyring, rotateSecrets } from '../../src/server/platform/secrets';

export type SecretsIo = { out: (line: string) => void; err: (line: string) => void };

export type SecretsCtx = {
  io: SecretsIo;
  /** Открыть БД и вернуть закрытие. По умолчанию — openScriptDb (DATABASE_URL). */
  openDb: () => Promise<() => Promise<void>>;
  env: Record<string, string | undefined>;
};

export const SECRETS_USAGE = `Использование: crmctl secrets rotate [--check]
  rotate          перешифровать секреты интеграций текущим ключом (CRM_SECRETS_KID)
  rotate --check  проверить, что все секреты открываются ключами из окружения; ничего не меняет`;

const defaultCtx = (): SecretsCtx => ({
  io: { out: (l) => console.log(l), err: (l) => console.error(l) },
  openDb: openScriptDb,
  env: process.env,
});

export async function runSecrets(argv: string[], ctx: SecretsCtx = defaultCtx()): Promise<number> {
  const { io } = ctx;
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    io.out(SECRETS_USAGE);
    return sub ? 0 : 1;
  }
  const check = rest.length === 1 && rest[0] === '--check';
  if (sub !== 'rotate' || (rest.length > 0 && !check)) {
    io.err(SECRETS_USAGE);
    return 1;
  }
  let close: (() => Promise<void>) | null = null;
  try {
    const ring = loadKeyring(ctx.env);
    close = await ctx.openDb();
    const sql = (await getDb()).sql;
    if (check) {
      const r = await checkSecrets(sql, ring);
      io.out(`Секретов: ${r.total}; открываются: ${r.ok}; не открываются: ${r.failed}; на старом ключе: ${r.stale}`);
      return r.failed === 0 ? 0 : 1;
    }
    const r = await rotateSecrets(sql, ring);
    io.out(`Перешифровано: ${r.rotated}; не открылось: ${r.failed}`);
    return r.failed === 0 ? 0 : 1;
  } catch (e) {
    // Ошибки секретов — только код: ни ключа, ни значения в выводе
    if (isSecretError(e)) io.err(`Ошибка ключей шифрования: ${e.code}`);
    else io.err(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    if (close) await close();
  }
}
