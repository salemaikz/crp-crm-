// Генерация окружения установки: /etc/crm/app.env и db.env (root, 0600). Образцы — deploy/compose/*.env.example.
// Существующие файлы не перезаписываются: повторный install не должен менять пароли и ключи.
import { mkdir, writeFile, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { Deps } from './types';

export interface Generated {
  /** Печатаются оператору один раз; в журналы не попадают. */
  secrets: { name: string; value: string }[];
  created: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const hex = (deps: Deps, n: number) => deps.randomBytes(n).toString('hex');
const b64 = (deps: Deps, n: number) => deps.randomBytes(n).toString('base64');

export async function ensureEnvFiles(deps: Deps, opts: { domain: string }): Promise<Generated> {
  const appEnv = path.join(deps.paths.etcDir, 'app.env');
  const dbEnv = path.join(deps.paths.etcDir, 'db.env');
  if ((await exists(appEnv)) && (await exists(dbEnv))) return { secrets: [], created: false };

  await mkdir(deps.paths.etcDir, { recursive: true, mode: 0o755 });
  const ownerPw = hex(deps, 24);
  const appPw = hex(deps, 24);
  const aes = b64(deps, 32);
  const phoneKey = b64(deps, 32);
  const iinKey = b64(deps, 32);
  const lines = [
    '# Создан crmctl install. Права 0600, владелец root. Не копировать в репозиторий и чаты.',
    `DATABASE_URL=postgres://crm_app:${appPw}@db:5432/crm`,
    `MIGRATE_DATABASE_URL=postgres://crm_owner:${ownerPw}@db:5432/crm`,
    `APP_ORIGIN=https://${opts.domain}`,
    'CRM_SECRETS_KID=k1',
    `CRM_SECRETS_KEY_k1=${aes}`,
    `CRM_PHONE_HMAC_KEY=${phoneKey}`,
    `CRM_IIN_HMAC_KEY=${iinKey}`,
    'LICENSE_PATH=/var/lib/crm/license/license.crm',
    'INGEST_PUBLIC=0',
    'TELEMETRY=off',
    '',
  ];
  await writeFile(appEnv, lines.join('\n'), { mode: 0o600 });
  await chmod(appEnv, 0o600);
  await writeFile(dbEnv, `POSTGRES_PASSWORD=${ownerPw}\nCRM_APP_PASSWORD=${appPw}\n`, { mode: 0o600 });
  await chmod(dbEnv, 0o600);
  return {
    created: true,
    secrets: [
      { name: 'CRM_SECRETS_KEY_k1', value: aes },
      { name: 'CRM_PHONE_HMAC_KEY', value: phoneKey },
      { name: 'CRM_IIN_HMAC_KEY', value: iinKey },
    ],
  };
}

/** Значение переменной из env-файла KEY=VALUE (без кавычек). */
export function envValue(body: string, key: string): string | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return null;
}
