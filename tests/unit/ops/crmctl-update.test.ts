// Сценарии update/rollback с подменой docker/compose (DEPLOY §5.2): до переключения сбой не трогает
// работающую версию; после — автооткат на прежний тег.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../../scripts/crmctl';
import { readState } from '../../../scripts/crmctl/state';
import { makeFake, seedInstalled, writePackage, type Fake } from './crmctl-fakes';

const FAST = ['--wait-seconds', '1', '--recheck-seconds', '120'];

async function setup(): Promise<{ f: Fake; pkg: string }> {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  const pkg = await writePackage(f.dirs.lib, '1.1.0');
  return { f, pkg };
}
/** Подкоманды compose, которые что-то меняют на сервере. */
const switched = (f: Fake) => f.compose('up').filter((c) => c.args.includes('app'));

test('успех: загрузка, миграции, кандидат, переключение, повторная проверка через 2 минуты', async () => {
  const { f, pkg } = await setup();
  f.server.pending = true;
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 0, f.err.join('\n'));
  assert.equal(f.server.running, '1.1.0');
  assert.equal(f.calls.filter((c) => c.cmd === '/fake/backup.sh').length, 1, 'копия перед миграциями');
  assert.ok(f.sleeps.includes(120_000), 'пауза 2 минуты перед повторной проверкой');
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version, '1.1.0');
  assert.equal(st?.previous?.version, '1.0.0');
  assert.match(await readFile(path.join(f.dirs.etc, 'project.env'), 'utf8'), /CRM_VERSION=1\.1\.0/);
  assert.equal(f.calls.some((c) => c.args.includes('rm') && c.args.includes('crm-app-next')), true, 'кандидат убран');
  // порядок: миграция раньше переключения
  const iMigrate = f.calls.findIndex((c) => c.args.includes('migrate') && !c.args.includes('--status'));
  const iSwitch = f.calls.findIndex((c) => c.args.includes('up') && c.args.includes('app'));
  assert.ok(iMigrate !== -1 && iMigrate < iSwitch);
});

test('без новых миграций копия не делается', async () => {
  const { f, pkg } = await setup();
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 0);
  assert.equal(f.calls.filter((c) => c.cmd === '/fake/backup.sh').length, 0);
});

test('подпись пакета не принята: стоп до загрузки образов и переключения', async () => {
  const { f, pkg } = await setup();
  f.verdicts.package = false;
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /Подпись пакета не принята/);
  assert.equal(f.calls.some((c) => c.args[0] === 'load'), false);
  assert.equal(switched(f).length, 0);
  assert.equal(f.server.running, '1.0.0');
});

test('лицензия не принята новым образом: стоп до миграций и переключения, прежняя работает', async () => {
  const { f, pkg } = await setup();
  f.server.pending = true;
  f.verdicts.license = false;
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /Лицензия не принята новым образом/);
  assert.equal(f.calls.filter((c) => c.cmd === '/fake/backup.sh').length, 0);
  assert.equal(f.compose('run').filter((c) => !c.args.includes('--status')).length, 0, 'миграции не запускались');
  assert.equal(switched(f).length, 0);
  assert.equal((await readState(f.deps.paths))?.current.version, '1.0.0');
});

test('копия не удалась: миграции не идут', async () => {
  const { f, pkg } = await setup();
  f.server.pending = true;
  f.server.backupCode = 1;
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /Копия БД не сделана/);
  assert.equal(f.compose('run').filter((c) => !c.args.includes('--status')).length, 0);
  assert.equal(switched(f).length, 0);
});

test('миграция упала: переключения нет, версия прежняя', async () => {
  const { f, pkg } = await setup();
  f.server.pending = true;
  f.server.migrateCode = 1;
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.equal(switched(f).length, 0);
  assert.equal(f.server.running, '1.0.0');
});

test('кандидат нездоров: переключения нет, кандидат удалён', async () => {
  const { f, pkg } = await setup();
  f.server.candidateUnhealthy.add('1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /не прошла \/api\/health до переключения/);
  assert.equal(switched(f).length, 0);
  assert.equal(f.calls.filter((c) => c.args[0] === 'rm' && c.args.includes('crm-app-next')).length >= 2, true);
  assert.equal((await readState(f.deps.paths))?.current.version, '1.0.0');
});

test('health после переключения не прошёл: автооткат на прежний тег, state и project.env возвращены', async () => {
  const { f, pkg } = await setup();
  f.server.unhealthy.add('1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.equal(f.server.running, '1.0.0');
  assert.match(f.err.join('\n'), /Автооткат на 1\.0\.0/);
  assert.match(f.err.join('\n'), /Откат выполнен/);
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version, '1.0.0');
  assert.equal(st?.previous, null);
  assert.match(await readFile(path.join(f.dirs.etc, 'project.env'), 'utf8'), /CRM_VERSION=1\.0\.0/);
  assert.match(await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8'), /1\.0\.0/, 'compose прежней версии');
});

test('сбой через 2 минуты: автооткат', async () => {
  const { f, pkg } = await setup();
  f.server.onSleep = () => f.server.unhealthy.add('1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.equal(f.server.running, '1.0.0');
  assert.match(f.err.join('\n'), /через 120 с/);
});

test('compose up упал: автооткат', async () => {
  const { f, pkg } = await setup();
  f.server.composeUpFails.add('1.1.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.equal(f.server.running, '1.0.0');
});

test('откат не удался: код 2 и инструкция', async () => {
  const { f, pkg } = await setup();
  f.server.unhealthy.add('1.1.0');
  f.server.unhealthy.add('1.0.0');
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 2);
  assert.match(f.err.join('\n'), /ОТКАТ НЕ УДАЛСЯ/);
});

test('отказы по пакету: та же версия, старше, другой клиент, minFromVersion, схема ниже текущей', async () => {
  const { f } = await setup();
  const same = await writePackage(f.dirs.lib, '1.0.0');
  assert.equal(await run(['update', same, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /уже установлена/);

  const f2 = await makeFake();
  await seedInstalled(f2, '1.2.0');
  assert.equal(await run(['update', await writePackage(f2.dirs.lib, '1.1.0'), ...FAST], f2.deps), 1);
  assert.match(f2.err.join('\n'), /rollback/);

  const f3 = await makeFake();
  await seedInstalled(f3, '1.0.0');
  assert.equal(await run(['update', await writePackage(f3.dirs.lib, '1.1.0', { customer: 'other' }), ...FAST], f3.deps), 1);
  assert.match(f3.err.join('\n'), /другого клиента/);

  const f4 = await makeFake();
  await seedInstalled(f4, '1.0.0');
  assert.equal(await run(['update', await writePackage(f4.dirs.lib, '1.3.0', { minFromVersion: '1.2.0' }), ...FAST], f4.deps), 1);
  assert.match(f4.err.join('\n'), /1\.2\.0 и выше/);

  const f5 = await makeFake();
  await seedInstalled(f5, '1.0.0');
  f5.server.schema = '2026-11-01-later.sql';
  assert.equal(await run(['update', await writePackage(f5.dirs.lib, '1.1.0'), ...FAST], f5.deps), 1);
  assert.match(f5.err.join('\n'), /ниже текущей/);
  for (const x of [f, f2, f3, f4, f5]) assert.equal(switched(x).length, 0);
});

test('повреждённый manifest.json не доходит до проверки подписи', async () => {
  const { f, pkg } = await setup();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(pkg, 'manifest.json'), JSON.stringify({ version: '1.1.0' }));
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /manifest\.json не прошёл проверку/);
});

test('образ не совпадает с digest из manifest: стоп', async () => {
  const { f, pkg } = await setup();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(pkg, 'manifest.json'),
    JSON.stringify({
      customer: 'crp', version: '1.1.0', buildId: 'b', schemaVersion: '2026-10-21-platform-schema-v1.sql',
      configSchemaVersion: 1, minFromVersion: '',
      images: [{ ref: 'crm-app:1.1.0', digest: `sha256:${'0'.repeat(64)}` }],
    }),
  );
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /не совпадает с manifest/);
  assert.equal(switched(f).length, 0);
});

test('rollback: прежняя версия поднята, previous и current поменялись местами, compose возвращён', async () => {
  const { f, pkg } = await setup();
  assert.equal(await run(['update', pkg, ...FAST], f.deps), 0);
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.equal(f.server.running, '1.0.0');
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version, '1.0.0');
  assert.equal(st?.previous?.version, '1.1.0');
  assert.match(f.out.join('\n'), /правки настроек/);
  assert.match(await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8'), /1\.0\.0/);
  // и обратно
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0);
  assert.equal(f.server.running, '1.1.0');
  assert.match(await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8'), /1\.1\.0/);
});

test('rollback без прежней версии и без образа — ошибка; прежняя нездорова — код 2', async () => {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  assert.equal(await run(['rollback'], f.deps), 1);
  assert.match(f.err.join('\n'), /некуда/);

  const g = await makeFake();
  await seedInstalled(g, '1.1.0', '1.0.0');
  g.server.images.delete('crm-app:1.0.0');
  assert.equal(await run(['rollback'], g.deps), 1);
  assert.match(g.err.join('\n'), /нет на сервере/);

  const h = await makeFake();
  await seedInstalled(h, '1.1.0', '1.0.0');
  h.server.unhealthy.add('1.0.0');
  assert.equal(await run(['rollback', '--wait-seconds', '1'], h.deps), 2);
});

test('rollback на образ без времени сборки (собран до D-290) — отказ до переключения; образ другого клиента — тоже', async () => {
  for (const [wm, why] of [
    [{ customer: 'crp', buildId: 'b-0' }, /без времени сборки/],
    [{ customer: 'crp', buildId: 'b-0', builtAt: null }, /без времени сборки/],
    [{ customer: null, buildId: null, builtAt: 1_790_000_000_000 }, /без водяного знака/],
    [{ customer: 'other-co', buildId: 'b-0', builtAt: 1_790_000_000_000 }, /other-co/],
  ] as const) {
    const f = await makeFake();
    await seedInstalled(f, '1.1.0', '1.0.0');
    f.server.imageWatermark = wm;
    assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 1, JSON.stringify(wm));
    assert.match(f.err.join('\n'), why);
    assert.equal(switched(f).length, 0, 'прежняя версия не поднималась');
    assert.equal((await readState(f.deps.paths))?.current.version, '1.1.0');
    const v = f.calls.find((c) => c.cmd === 'docker' && c.args[0] === 'run' && c.args.includes('license'));
    assert.ok(v?.args.includes('crm-app:1.0.0'), 'спрошено ядро целевого образа');
  }
});

test('status и health: код выхода отражает /api/health', async () => {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  assert.equal(await run(['health'], f.deps), 0);
  assert.equal(await run(['status'], f.deps), 0);
  assert.match(f.out.join('\n'), /Версия:\s+1\.0\.0/);
  f.server.unhealthy.add('1.0.0');
  assert.equal(await run(['health'], f.deps), 1);
  assert.equal(await run(['status'], f.deps), 1);
  const g = await makeFake();
  assert.equal(await run(['status'], g.deps), 1);
});

test('заглушка проверок закрыта по умолчанию и открывается только явным CRM_VERIFY_STUB=allow', async () => {
  const { stubVerifier } = await import('../../../scripts/crmctl/verify');
  const dummy = { dir: '/x', manifest: (await import('./crmctl-fakes')).manifestFor('1.0.0') };
  assert.equal((await stubVerifier({}).verifyPackage(dummy)).ok, false);
  assert.equal((await stubVerifier({ CRM_VERIFY_STUB: '1' }).verifyPackage(dummy)).ok, false);
  assert.equal((await stubVerifier({ CRM_VERIFY_STUB: 'allow' }).verifyPackage(dummy)).ok, true);
  assert.equal((await stubVerifier({}).verifyLicense({ image: 'x', licenseDir: '/l', installId: 'i' })).ok, false);
});
