import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intFlag, parseArgs, strFlag } from '../../../scripts/crmctl/args';
import { compareVersions } from '../../../scripts/crmctl/manifest';
import { normalizePhone } from '../../../scripts/crmctl/install';
import { run } from '../../../scripts/crmctl';
import { makeFake } from './crmctl-fakes';

test('команда, позиционные и флаги: --флаг=значение, --флаг значение, логические', () => {
  const a = parseArgs(['install', 'pkg.tar.zst', '--domain', 'crm.example.kz', '--admin-name=Иван Иванов', '--help']);
  assert.equal(a.command, 'install');
  assert.deepEqual(a.positional, ['pkg.tar.zst']);
  assert.deepEqual(a.flags, { domain: 'crm.example.kz', 'admin-name': 'Иван Иванов', help: true });
});

test('значение флага не может быть другим флагом или пустым; логический флаг без значения', () => {
  assert.throws(() => parseArgs(['install', '--domain']), /--domain/);
  assert.throws(() => parseArgs(['install', '--domain', '--admin-phone', '1']), /--domain/);
  assert.throws(() => parseArgs(['install', '--domain=']), /--domain/);
  assert.throws(() => parseArgs(['update', '--force=1']), /не принимает значение/);
});

test('-- завершает флаги', () => {
  const a = parseArgs(['update', '--', '--weird.tar.zst']);
  assert.deepEqual(a.positional, ['--weird.tar.zst']);
});

test('intFlag и strFlag: умолчание, ошибки', () => {
  assert.equal(intFlag({}, 'wait-seconds', 90), 90);
  assert.equal(intFlag({ 'wait-seconds': '5' }, 'wait-seconds', 90), 5);
  assert.throws(() => intFlag({ 'wait-seconds': '0' }, 'wait-seconds', 90), /положительное/);
  assert.throws(() => intFlag({ 'wait-seconds': '1.5' }, 'wait-seconds', 90), /положительное/);
  assert.equal(strFlag({}, 'domain', 'x'), 'x');
  assert.throws(() => strFlag({}, 'domain'), /--domain/);
});

test('номер администратора: только цифры, 10–15', () => {
  assert.equal(normalizePhone('+7 (701) 123-45-67'), '77011234567');
  assert.throws(() => normalizePhone('12345'), /10–15/);
  assert.throws(() => normalizePhone('abc'), /10–15/);
});

test('версии: порядок и пререлиз', () => {
  assert.ok(compareVersions('1.2.3', '1.2.2') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.0-rc1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-rc2', '1.0.0-rc1') > 0);
});

test('run: неизвестная команда — код 2, без команды — справка и код 2, help — 0', async () => {
  const f = await makeFake();
  assert.equal(await run(['nope'], f.deps), 2);
  assert.match(f.err.join('\n'), /Неизвестная команда: nope/);
  assert.equal(await run([], f.deps), 2);
  assert.equal(await run(['help'], f.deps), 0);
  assert.match(f.out.join('\n'), /update <пакет>/);
  assert.equal(await run(['update', '--wait-seconds', 'x'], f.deps), 2);
});

test('run: update без установки — понятная ошибка', async () => {
  const f = await makeFake();
  assert.equal(await run(['update', '/nowhere'], f.deps), 1);
  assert.match(f.err.join('\n'), /сначала crmctl install/);
});
