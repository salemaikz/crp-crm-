// crmctl install <пакет> --domain <хост> --admin-phone <номер> --admin-name <имя>
// Первичная установка на сервер (DEPLOY §4 п. 3): окружение, секреты, образы, роли БД, миграции, grants,
// installId, первый администратор по одноразовой ссылке. Лицензия на этом шаге не нужна: до
// `crmctl license install` установка в состоянии missing («только чтение»). Ядро образа должно нести
// водяной знак клиента пакета: общий образ (без знака) работает без лицензии и клиенту не ставится (D-213).
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { intFlag, strFlag, type ParsedArgs } from './args';
import { describe, mustCompose, psql, sqlLit } from './compose';
import { applyGrants, ensureRoles, runMigrate } from './db';
import { probeHost, waitHealthy } from './health';
import { loadImages } from './images';
import { assertImageForCustomer } from './license';
import { isDirectory } from './manifest';
import { assertImageKeys } from './pkgcmd';
import { embeddedCustomer, keepManifest, verifyAndUnpack } from './verify';
import { ensureFrameCsp } from './nginxCsp';
import { ensureEnvFiles, ensureProxyTrust, envValue } from './secrets';
import { composeFile, readState, writeProjectEnv, writeState } from './state';
import { CrmctlError, type Deps } from './types';

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!/^[0-9]{10,15}$/.test(digits)) throw new CrmctlError('--admin-phone: нужно 10–15 цифр', 2);
  return digits;
}

async function preflight(deps: Deps): Promise<void> {
  const docker = await deps.exec.run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (docker.code !== 0) throw new CrmctlError('Docker недоступен: запущен ли демон и есть ли права (sudo crmctl)?');
  const cmp = await deps.exec.run('docker', ['compose', 'version']);
  if (cmp.code !== 0) throw new CrmctlError('Нет плагина docker compose');
  const net = await deps.exec.run('docker', ['network', 'inspect', 'crm_ingest']);
  if (net.code !== 0) throw new CrmctlError('Нет сети crm_ingest: сначала deploy/install.sh (docker network create crm_ingest)');
}

export async function install(deps: Deps, args: ParsedArgs): Promise<number> {
  const pkg = args.positional[0];
  if (!pkg) throw new CrmctlError('Использование: crmctl install <пакет> --domain <хост> --admin-phone <номер> --admin-name <имя>', 2);
  const domain = strFlag(args.flags, 'domain');
  if (!DOMAIN_RE.test(domain)) throw new CrmctlError('--domain: ожидается имя хоста, например crm.example.kz', 2);
  const phone = normalizePhone(strFlag(args.flags, 'admin-phone'));
  const name = strFlag(args.flags, 'admin-name').trim();
  if (name.length < 1 || name.length > 100) throw new CrmctlError('--admin-name: от 1 до 100 символов', 2);
  const ttlHours = intFlag(args.flags, 'invite-ttl-hours', 72);
  const hostPort = intFlag(args.flags, 'host-port', 3100);
  const waitMs = intFlag(args.flags, 'wait-seconds', 90) * 1000;
  const { io, paths } = deps;

  // Подпись и состав пакета проверяются ДО любого вызова docker и записи в /etc/crm (D-315, §4.1)
  io.out('[1/8] Пакет и подпись');
  if (await readState(paths)) {
    throw new CrmctlError('Установка уже выполнена (есть state.json). Для новой версии — crmctl update');
  }
  const embedded = embeddedCustomer();
  const pk = await verifyAndUnpack(deps, pkg, {
    write: true,
    sig: typeof args.flags.sig === 'string' ? args.flags.sig : undefined,
    check: (m) => {
      if (embedded && m.customer !== embedded) throw new CrmctlError(`Пакет для другого клиента: ${m.customer}`);
    },
  });
  const { dir, manifest } = pk;
  await keepManifest(deps, pk);
  const version = manifest.version;

  io.out('[2/8] Проверка окружения');
  await preflight(deps);

  io.out('[3/8] Окружение и секреты');
  const gen = await ensureEnvFiles(deps, { domain });
  if (gen.created) {
    io.out('');
    io.out('СЕКРЕТЫ УСТАНОВКИ. Показаны один раз: сохраните копию вне сервера, директору — запечатанный конверт.');
    for (const s of gen.secrets) io.out(`${s.name}=${s.value}`);
    io.out('');
  }
  // Секрет доверенного прокси: в новом app.env он уже есть; в app.env прежней попытки — дописывается (D-155)
  await ensureProxyTrust(deps);
  // CSP frame-src окна чата Wazzup: только при FEATURE_WAZZUP=1 в app.env (D-270)
  await ensureFrameCsp(deps);
  const composeSrc = path.join(dir, 'compose');
  if (!(await isDirectory(composeSrc))) throw new CrmctlError('В пакете нет каталога compose/');
  await mkdir(path.dirname(composeFile(paths)), { recursive: true });
  await cp(composeSrc, path.dirname(composeFile(paths)), { recursive: true });
  await mkdir(path.join(paths.libDir, 'license'), { recursive: true });
  await writeProjectEnv(paths, version, manifest.buildId, hostPort);

  io.out('[4/8] Образы');
  await loadImages(deps, dir, manifest);
  // До БД и installId: общий образ или образ другого клиента не должен дойти до запуска
  await assertImageForCustomer(deps, `crm-app:${version}`, manifest.customer, undefined, manifest.builtAt);
  await assertImageKeys(deps, `crm-app:${version}`, manifest);

  io.out('[5/8] База данных: роли, миграции, права');
  await mustCompose(deps, version, 'Запуск БД', ['up', '-d', '--wait', 'db']);
  const dbEnv = await readFile(path.join(paths.etcDir, 'db.env'), 'utf8');
  const appPw = envValue(dbEnv, 'CRM_APP_PASSWORD');
  if (!appPw) throw new CrmctlError('В db.env нет CRM_APP_PASSWORD');
  await ensureRoles(deps, version, appPw);
  io.out((await runMigrate(deps, version)) || 'Миграции накатаны.');
  await applyGrants(deps, version);

  io.out('[6/8] installId и первый администратор');
  const now = deps.now();
  const token = deps.randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const sql = `
BEGIN;
INSERT INTO license_state (id, license_raw, install_id, state, last_seen_at, checked_at)
  VALUES (1, '', ${sqlLit(deps.randomUuid())}, 'missing', ${now}, ${now}) ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, phone_digits, name, is_admin, created_at)
  VALUES (${sqlLit(deps.randomUuid())}, ${sqlLit(phone)}, ${sqlLit(name)}, true, ${now}) ON CONFLICT (phone_digits) DO NOTHING;
INSERT INTO invites (id, token_hash, kind, phone_digits, space_id, role_key, team_id, expires_at, used_at, created_by, created_at)
  VALUES (${sqlLit(deps.randomUuid())}, ${sqlLit(tokenHash)}, 'reset', ${sqlLit(phone)}, NULL, '', NULL, ${now + ttlHours * 3600_000}, NULL, NULL, ${now});
INSERT INTO audit_log (id, actor_id, space_id, action, entity, entity_id, meta, created_at)
  VALUES (${sqlLit(deps.randomUuid())}, NULL, NULL, 'install.first_admin_invite', 'invite', ${sqlLit(tokenHash.slice(0, 12))}, '{}', ${now});
COMMIT;
SELECT install_id FROM license_state WHERE id = 1;
`;
  const r = await psql(deps, version, sql);
  if (r.code !== 0) throw new CrmctlError(`Запись installId и администратора: ${describe(r)}`);
  const installId = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!/^[0-9A-Za-z-]{8,64}$/.test(installId)) throw new CrmctlError('installId не получен из БД');
  await writeFile(path.join(paths.libDir, 'license', 'install-id'), `${installId}\n`, { mode: 0o644 });

  io.out('[7/8] Запуск приложения');
  await mustCompose(deps, version, 'Запуск app и worker', ['up', '-d', '--no-deps', 'app', 'worker']);
  const health = await waitHealthy(deps, () => probeHost(deps, hostPort, version), waitMs);
  if (!health.ok) {
    throw new CrmctlError(
      `app не ответил на /api/health (${health.detail}). Установка остановлена; логи: docker compose -p crm logs app. Повторный crmctl install безопасен`,
    );
  }

  await writeState(paths, {
    installId,
    customer: manifest.customer,
    current: { version, buildId: manifest.buildId, switchedAt: now, manifestSha256: pk.manifestSha256, kid: pk.kid, verified: pk.verified },
    previous: null,
    hostPort,
  });

  io.out('[8/8] Готово');
  io.out(`installId: ${installId}`);
  io.out('Передайте installId владельцу: он подпишет лицензию офлайн, затем crmctl license install <файл>.');
  io.out(`Ссылка первого входа администратора (одноразовая, ${ttlHours} ч): https://${domain}/invite#${token}`);
  return 0;
}
