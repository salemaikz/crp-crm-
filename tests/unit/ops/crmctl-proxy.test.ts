// Доверенный прокси по секрету (D-155) в crmctl: генератор app.env, дописывание строк в существующие
// app.env и конфиг nginx при update, ничего не затирая; отказ nginx -t возвращает конфиг.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../../scripts/crmctl';
import {
  ensureEnvFiles,
  ensureProxyTrust,
  envValue,
  nginxSecretConf,
  patchNginxConf,
  proxyIncludeLine,
  proxySecretFile,
} from '../../../scripts/crmctl/secrets';
import { proxySecret } from '../../../src/server/platform/http/trustedProxy';
import { SEED_APP_ENV, makeFake, seedInstalled, writePackage, type Fake } from './crmctl-fakes';

const FAST = ['--wait-seconds', '1', '--recheck-seconds', '1'];
const TEMPLATE = await readFile('deploy/nginx/crm.conf.template', 'utf8');
/** Конфиг nginx на хосте, отрисованный шаблоном до D-155 (без include секрета). */
const OLD_CONF = TEMPLATE.split('\n')
  .filter((l) => !l.includes('nginx-proxy.d/*.conf') && !/X-Proxy-Secret = CRM_PROXY_SECRET|секрет приложение не верит/.test(l))
  .join('\n');

const appEnv = (f: Fake) => path.join(f.dirs.etc, 'app.env');
const modeOf = async (p: string) => (await stat(p)).mode & 0o777;
const nginxCalls = (f: Fake) => f.calls.filter((c) => c.cmd === 'nginx' || c.cmd === 'systemctl').map((c) => [c.cmd, ...c.args].join(' '));

test('генератор app.env пишет CRM_PROXY_SECRET годного формата и APP_ORIGIN; секрет не печатается', async () => {
  const f = await makeFake();
  const gen = await ensureEnvFiles(f.deps, { domain: 'crm.example.kz' });
  assert.equal(gen.created, true);
  const body = await readFile(appEnv(f), 'utf8');
  const secret = envValue(body, 'CRM_PROXY_SECRET');
  assert.ok(secret, 'строка есть');
  assert.equal(proxySecret({ CRM_PROXY_SECRET: secret }), secret, 'приложение принимает формат');
  assert.equal(envValue(body, 'APP_ORIGIN'), 'https://crm.example.kz');
  assert.equal(envValue(body, 'TRUST_X_REAL_IP'), null, 'устаревшая строка не пишется');
  assert.ok(!gen.secrets.some((s) => s.name === 'CRM_PROXY_SECRET'), 'секрет прокси не показывается оператору');
  assert.equal(await modeOf(appEnv(f)), 0o600);
});

test('install: секрет в app.env и в файле nginx совпадают, в вывод не попадает', async () => {
  const f = await makeFake();
  await mkdir(path.dirname(f.dirs.nginxConf), { recursive: true });
  await writeFile(f.dirs.nginxConf, OLD_CONF);
  const pkg = await writePackage(f.dirs.lib, '1.0.0');
  const code = await run(
    ['install', pkg, '--domain', 'crm.example.kz', '--admin-phone', '77090000000', '--admin-name', 'Синтетика', ...FAST],
    f.deps,
  );
  assert.equal(code, 0, f.err.join('\n'));
  const secret = envValue(await readFile(appEnv(f), 'utf8'), 'CRM_PROXY_SECRET') as string;
  assert.equal(await readFile(proxySecretFile(f.deps), 'utf8'), nginxSecretConf(secret));
  assert.equal(await modeOf(proxySecretFile(f.deps)), 0o600);
  assert.ok(!f.out.join('\n').includes(secret), 'значение секрета не печатается');
  assert.equal((await readFile(f.dirs.nginxConf, 'utf8')).split(proxyIncludeLine(f.deps)).length - 1, 2);
  assert.deepEqual(nginxCalls(f), ['nginx -t', 'systemctl reload nginx']);
});

test('update дописывает CRM_PROXY_SECRET в существующий app.env, ничего не затирая, и пишет об этом в журнал', async () => {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  const pkg = await writePackage(f.dirs.lib, '1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 0, f.err.join('\n'));
  const body = await readFile(appEnv(f), 'utf8');
  assert.ok(body.startsWith(SEED_APP_ENV), 'прежние строки на месте и в том же порядке');
  const secret = envValue(body, 'CRM_PROXY_SECRET') as string;
  assert.ok(proxySecret({ CRM_PROXY_SECRET: secret }));
  assert.equal(await modeOf(appEnv(f)), 0o600);
  assert.match(f.out.join('\n'), /дописана строка CRM_PROXY_SECRET \(значение не печатается\)/);
  assert.ok(!f.out.join('\n').includes(secret));
  assert.equal(await readFile(proxySecretFile(f.deps), 'utf8'), nginxSecretConf(secret));
  // строки дописаны до проверки кандидата: новая версия стартует уже с секретом
  assert.match(f.out.join('\n'), /CRM_PROXY_SECRET[\s\S]*\[4\/7\]/);
});

test('update: секрет уже есть — app.env не трогается; без конфига nginx на хосте — пропуск без reload', async () => {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  const secret = 'Z'.repeat(43);
  await writeFile(appEnv(f), `${SEED_APP_ENV}CRM_PROXY_SECRET=${secret}\n`, { mode: 0o600 });
  const before = await readFile(appEnv(f), 'utf8');
  const pkg = await writePackage(f.dirs.lib, '1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 0, f.err.join('\n'));
  assert.equal(await readFile(appEnv(f), 'utf8'), before);
  assert.equal(await readFile(proxySecretFile(f.deps), 'utf8'), nginxSecretConf(secret));
  assert.match(f.out.join('\n'), /не найден — пропущено/);
  assert.deepEqual(nginxCalls(f), []);
});

test('update дописывает include секрета в оба location старого конфига nginx; повтор — без изменений и reload', async () => {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  await mkdir(path.dirname(f.dirs.nginxConf), { recursive: true });
  await writeFile(f.dirs.nginxConf, OLD_CONF);
  assert.equal((await ensureProxyTrust(f.deps)).changed, true);
  const conf = await readFile(f.dirs.nginxConf, 'utf8');
  const include = proxyIncludeLine(f.deps);
  assert.equal(conf.split(include).length - 1, 2);
  // прежний текст сохранён: без добавленных строк конфиг совпадает со старым
  assert.equal(conf.split('\n').filter((l) => l.trim() !== include).join('\n'), OLD_CONF);
  assert.match(f.out.join('\n'), /дописано «include .*nginx-proxy\.d\/\*\.conf;» в 2 location/);
  assert.deepEqual(nginxCalls(f), ['nginx -t', 'systemctl reload nginx']);

  f.calls.length = 0;
  assert.equal((await ensureProxyTrust(f.deps)).changed, false);
  assert.equal(await readFile(f.dirs.nginxConf, 'utf8'), conf);
  assert.deepEqual(nginxCalls(f), []);
});

test('nginx -t не прошёл: конфиг возвращён как был, update остановлен до переключения', async () => {
  const f = await makeFake((cmd) => (cmd === 'nginx' ? { code: 1, stdout: '', stderr: 'emerg: синтетика' } : undefined));
  await seedInstalled(f, '1.0.0');
  await mkdir(path.dirname(f.dirs.nginxConf), { recursive: true });
  await writeFile(f.dirs.nginxConf, OLD_CONF);
  const pkg = await writePackage(f.dirs.lib, '1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /nginx -t не прошёл, .* возвращён как был/);
  assert.equal(await readFile(f.dirs.nginxConf, 'utf8'), OLD_CONF);
  assert.equal(f.server.running, '1.0.0');
  assert.equal(f.calls.some((c) => c.cmd === 'systemctl'), false);
});

test('CRM_PROXY_SECRET не того формата: отказ без правок app.env', async () => {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  await writeFile(appEnv(f), `${SEED_APP_ENV}CRM_PROXY_SECRET=short\n`, { mode: 0o600 });
  const before = await readFile(appEnv(f), 'utf8');
  await assert.rejects(ensureProxyTrust(f.deps), /не того формата/);
  assert.equal(await readFile(appEnv(f), 'utf8'), before);
});

test('app.env без перевода строки в конце: строка дописывается с новой строки', async () => {
  const f = await makeFake();
  await writeFile(appEnv(f), 'APP_ORIGIN=https://crm.example.kz', { mode: 0o600 });
  await ensureProxyTrust(f.deps);
  const body = await readFile(appEnv(f), 'utf8');
  assert.equal(envValue(body, 'APP_ORIGIN'), 'https://crm.example.kz');
  assert.ok(envValue(body, 'CRM_PROXY_SECRET'));
});

test('patchNginxConf: шаблон установки уже содержит include — правок нет', () => {
  const r = patchNginxConf(TEMPLATE, 'include /etc/crm/nginx-proxy.d/*.conf;');
  assert.equal(r.added, 0);
  assert.equal(r.body, TEMPLATE);
});
