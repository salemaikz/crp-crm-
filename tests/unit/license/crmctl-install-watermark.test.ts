// crmctl install сверяет водяной знак ядра образа с клиентом пакета (D-213): общий образ без знака работает
// без лицензии, поэтому клиенту не ставится; образ другого клиента — тоже. Проверка — до БД и installId.
// Docker подменён фейком (crmctl-fakes), данные синтетические.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../scripts/crmctl';
import { makeFake, writePackage, type Fake } from '../ops/crmctl-fakes';

const FAST = ['--wait-seconds', '1'];

async function install(f: Fake): Promise<number> {
  const pkg = await writePackage(f.dirs.lib, '1.0.0');
  return run(['install', pkg, '--domain', 'crm.example.kz', '--admin-phone', '77090000001', '--admin-name', 'Синтетика', ...FAST], f.deps);
}

const verifyRuns = (f: Fake) => f.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'run' && c.args.includes('license'));
const touchedDb = (f: Fake) => f.calls.some((c) => (c.input ?? '').includes('INSERT INTO license_state'));
const startedApp = (f: Fake) => f.compose('up').some((c) => c.args.includes('app'));

test('install: ядро образа собрано для клиента пакета — установка идёт; проверка без сети и без файла', async () => {
  const f = await makeFake();
  assert.equal(await install(f), 0, f.err.join('\n'));
  const [r] = verifyRuns(f);
  assert.ok(r, 'образ спрошен о водяном знаке');
  assert.ok(r.args.includes('crm-app:1.0.0'));
  assert.deepEqual(r.args.slice(r.args.indexOf('--network'), r.args.indexOf('--network') + 2), ['--network', 'none']);
  assert.equal(r.args.includes('-v'), false, 'файл лицензии не монтируется');
  assert.ok(touchedDb(f));
});

test('install: общий образ (без водяного знака) клиенту не ставится — до БД, installId и запуска', async () => {
  const f = await makeFake();
  f.server.imageWatermark = { customer: null, buildId: null };
  assert.notEqual(await install(f), 0);
  assert.match(f.err.join('\n'), /без водяного знака клиента \(общая сборка\)/);
  assert.equal(touchedDb(f), false);
  assert.equal(startedApp(f), false);
});

test('install: образ, собранный для другого клиента, — отказ', async () => {
  const f = await makeFake();
  f.server.imageWatermark = { customer: 'other-co', buildId: 'b-9' };
  assert.notEqual(await install(f), 0);
  assert.match(f.err.join('\n'), /собрано для клиента other-co, установка — crp/);
  assert.equal(touchedDb(f), false);
  assert.equal(startedApp(f), false);
});
