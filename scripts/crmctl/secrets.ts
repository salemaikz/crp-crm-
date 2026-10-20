// Генерация окружения установки: /etc/crm/app.env и db.env (root, 0600). Образцы — deploy/compose/*.env.example.
// Существующие файлы не перезаписываются: повторный install не должен менять пароли и ключи.
// Недостающие обязательные строки (CRM_PROXY_SECRET, D-155) дописываются в конец app.env — ensureProxyTrust.
import { mkdir, writeFile, stat, chmod, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { CrmctlError, type Deps } from './types';

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
/** Секрет доверенного прокси: 32 байта в base64url (43 символа) — без кавычек и '=' для app.env и nginx. */
const proxySecretValue = (deps: Deps) => deps.randomBytes(32).toString('base64url');

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
    '# Секрет доверенного прокси (D-155): nginx ставит его в X-Proxy-Secret, копия — /etc/crm/nginx-proxy.d/secret.conf',
    `CRM_PROXY_SECRET=${proxySecretValue(deps)}`,
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

// ---------- Доверенный прокси (D-155) ----------

/** Формат CRM_PROXY_SECRET — как PROXY_SECRET_RE в src/server/platform/http/trustedProxy.ts. */
export const PROXY_SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const NGINX_CONF_DEFAULT = '/etc/nginx/conf.d/crm.conf';
const VIA_PROXY_LINE = /^(\s*)proxy_set_header\s+X-Via-Proxy\s+1;\s*$/;

export const proxyDir = (deps: Deps) => path.join(deps.paths.etcDir, 'nginx-proxy.d');
export const proxySecretFile = (deps: Deps) => path.join(proxyDir(deps), 'secret.conf');
/** Строка, которую шаблон nginx держит в каждом проксирующем location (deploy/nginx/crm.conf.template). */
export const proxyIncludeLine = (deps: Deps) => `include ${proxyDir(deps)}/*.conf;`;

/** Содержимое файла секрета для nginx: заголовок с тем же значением, что CRM_PROXY_SECRET в app.env. */
export function nginxSecretConf(secret: string): string {
  return [
    '# Создан crmctl (D-155). Root, 0600. Значение = CRM_PROXY_SECRET из /etc/crm/app.env. Не копировать.',
    `proxy_set_header X-Proxy-Secret "${secret}";`,
    '',
  ].join('\n');
}

/**
 * Дописать include секрета после каждого `proxy_set_header X-Via-Proxy 1;`, где его ещё нет в том же
 * location. Остальной текст не меняется. added — сколько location дополнено.
 */
export function patchNginxConf(body: string, includeLine: string): { body: string; added: number } {
  const lines = body.split('\n');
  const out: string[] = [];
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    out.push(line);
    const m = VIA_PROXY_LINE.exec(line);
    if (!m) continue;
    // До конца блока: закрывающая скобка на меньшем отступе, чем директива
    let has = false;
    for (let k = i + 1; k < lines.length; k++) {
      const next = lines[k] as string;
      if (next.trim() === includeLine) has = true;
      if (/^\s*}/.test(next) && (next.length - next.trimStart().length) < (m[1] as string).length) break;
    }
    if (!has) {
      out.push(`${m[1]}${includeLine}`);
      added++;
    }
  }
  return { body: out.join('\n'), added };
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Запись через временный файл и rename: оборванная запись не оставит полфайла. */
async function writeAtomic(file: string, body: string, mode: number): Promise<void> {
  const tmp = `${file}.crmctl-tmp`;
  await writeFile(tmp, body, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/**
 * Доверенный прокси по секрету (D-155), для install и update. Ничего не затирает:
 * 1) в /etc/crm/app.env дописывает CRM_PROXY_SECRET, если строки нет (старые установки);
 * 2) пишет секрет для nginx в /etc/crm/nginx-proxy.d/secret.conf (файл crmctl; сверяется с app.env);
 * 3) в конфиг nginx на хосте (CRM_NGINX_CONF, по умолчанию /etc/nginx/conf.d/crm.conf) дописывает include
 *    в location с X-Via-Proxy, если его нет; затем `nginx -t` и reload. Не прошёл `nginx -t` — конфиг
 *    возвращается как был, команда останавливается (в update — до переключения версии).
 * Каждое изменение пишется в вывод команды; значение секрета — никогда.
 */
export async function ensureProxyTrust(deps: Deps): Promise<{ changed: boolean }> {
  const { io } = deps;
  const appEnv = path.join(deps.paths.etcDir, 'app.env');
  const envBody = await readOrNull(appEnv);
  if (envBody === null) throw new CrmctlError(`Нет ${appEnv}: сначала crmctl install`);
  let secret = envValue(envBody, 'CRM_PROXY_SECRET')?.trim() ?? null;
  let changed = false;
  if (secret !== null && !PROXY_SECRET_RE.test(secret)) {
    throw new CrmctlError(
      `CRM_PROXY_SECRET в ${appEnv} не того формата (base64url, от 32 символов). Удалите эту строку — crmctl допишет новую`,
    );
  }
  if (secret === null) {
    secret = proxySecretValue(deps);
    const sep = envBody === '' || envBody.endsWith('\n') ? '' : '\n';
    const tail = [
      `# Дописано crmctl ${new Date(deps.now()).toISOString()}: секрет доверенного прокси (D-155)`,
      `CRM_PROXY_SECRET=${secret}`,
      '',
    ].join('\n');
    await writeAtomic(appEnv, `${envBody}${sep}${tail}`, 0o600);
    io.out(`Окружение: в ${appEnv} дописана строка CRM_PROXY_SECRET (значение не печатается)`);
    changed = true;
  }

  await mkdir(proxyDir(deps), { recursive: true, mode: 0o700 });
  await chmod(proxyDir(deps), 0o700);
  const secretFile = proxySecretFile(deps);
  const want = nginxSecretConf(secret);
  const secretChanged = (await readOrNull(secretFile)) !== want;
  if (secretChanged) {
    await writeAtomic(secretFile, want, 0o600);
    io.out(`nginx: записан ${secretFile} (секрет из app.env)`);
    changed = true;
  }

  const confPath = deps.env.CRM_NGINX_CONF?.trim() || NGINX_CONF_DEFAULT;
  const conf = await readOrNull(confPath);
  if (conf === null) {
    io.out(`nginx: ${confPath} не найден — пропущено (nginx в compose-профиле edge читает ${proxyDir(deps)} при перезапуске)`);
    return { changed };
  }
  const include = proxyIncludeLine(deps);
  const patched = patchNginxConf(conf, include);
  if (patched.added > 0) {
    await writeAtomic(confPath, patched.body, 0o644);
    io.out(`nginx: в ${confPath} дописано «${include}» в ${patched.added} location`);
  }
  const usesSecret = patched.body.split('\n').some((l) => l.trim() === include);
  if (patched.added === 0 && !(secretChanged && usesSecret)) return { changed };
  const t = await deps.exec.run('nginx', ['-t']);
  if (t.code !== 0) {
    if (patched.added > 0) await writeAtomic(confPath, conf, 0o644);
    throw new CrmctlError(`nginx -t не прошёл, ${confPath} возвращён как был: ${(t.stderr || t.stdout).trim()}`);
  }
  const r = await deps.exec.run('systemctl', ['reload', 'nginx']);
  if (r.code !== 0) throw new CrmctlError(`systemctl reload nginx: ${(r.stderr || r.stdout).trim()}`);
  io.out('nginx: конфигурация проверена (nginx -t) и перечитана');
  return { changed: true };
}
