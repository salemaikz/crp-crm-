// crmctl config: разбор аргументов, коды выхода при неверном вызове (БД не нужна).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runConfig, type ConfigCtx } from '../../../scripts/crmctl/config';

function ctx(): { c: ConfigCtx; out: string[]; err: string[]; opened: () => number } {
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  const c: ConfigCtx = {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    openDb: async () => {
      opened++;
      return async () => {};
    },
    env: {},
    productVersion: async () => '0.1.0',
  };
  return { c, out, err, opened: () => opened };
}

test('parseArgs: флаги, значения и позиционные', () => {
  const p = parseArgs(['--layers', 'base,kz', '--yes', 'a', '--force', 'b']);
  assert.equal(p.flags.get('layers'), 'base,kz');
  assert.equal(p.flags.get('yes'), true);
  assert.equal(p.flags.get('force'), true);
  assert.deepEqual(p.positional, ['a', 'b']);
  assert.equal(parseArgs(['--layers=base']).flags.get('layers'), 'base');
});

test('parseArgs: у --layers должно быть значение', () => {
  assert.throws(() => parseArgs(['--layers']), /нужно значение/);
  assert.throws(() => parseArgs(['--layers', '--yes']), /нужно значение/);
});

test('runConfig: без подкоманды — справка и код 1; --help — код 0', async () => {
  const a = ctx();
  assert.equal(await runConfig([], a.c), 1);
  assert.match(a.out.join('\n'), /Использование: crmctl config/);
  const b = ctx();
  assert.equal(await runConfig(['--help'], b.c), 0);
});

test('runConfig: неизвестная подкоманда и флаг — код 1, БД не открывается', async () => {
  const a = ctx();
  assert.equal(await runConfig(['bogus'], a.c), 1);
  assert.match(a.err.join('\n'), /неизвестная подкоманда/);
  assert.equal(a.opened(), 0);
  const b = ctx();
  assert.equal(await runConfig(['apply', '--layers', 'base', '--frobnicate'], b.c), 1);
  assert.match(b.err.join('\n'), /неизвестный флаг/);
  assert.equal(b.opened(), 0);
});

test('runConfig: apply без --layers — код 1', async () => {
  const a = ctx();
  assert.equal(await runConfig(['apply'], a.c), 1);
  assert.match(a.err.join('\n'), /--layers/);
});

test('runConfig: rollback и set с неверными аргументами — код 1', async () => {
  for (const argv of [['rollback'], ['rollback', 'global', 'x'], ['set', 'global'], ['set', 'global', 'org.timezone', '{bad']]) {
    const a = ctx();
    assert.equal(await runConfig(argv, a.c), 1, argv.join(' '));
  }
});

test('runConfig: несуществующий слой — код 1 с понятным сообщением', async () => {
  const a = ctx();
  a.c.env = { CRM_PRESETS_DIR: '/nonexistent-presets-dir' };
  assert.equal(await runConfig(['apply', '--layers', 'base'], a.c), 1);
  assert.match(a.err.join('\n'), /файла нет/);
});
