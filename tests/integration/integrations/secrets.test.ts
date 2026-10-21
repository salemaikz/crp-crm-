// Секреты интеграций в БД (D-269, O5): шифротекст вместо значения, last4, перезапись, удаление, ротация ключа
// командой `crmctl secrets rotate [--check]`, контекст плагина расшифровывает только при вызове.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runSecrets } from '../../../scripts/crmctl/secretsRotate';
import { buildCtx } from '../../../src/server/domain/integrations';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import {
  SecretError,
  deleteIntegrationSecrets,
  describeIntegrationSecrets,
  getIntegrationSecret,
  loadKeyring,
  putIntegrationSecret,
} from '../../../src/server/platform/secrets';
import { T0, deps, fakeMessenger, insertIntegration } from './helpers';

let db: TestDb;
const KEY = 'synthetic-wazzup-key-0123456789abcd';
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const saved = { kid: process.env.CRM_SECRETS_KID, k1: process.env.CRM_SECRETS_KEY_k1, k2: process.env.CRM_SECRETS_KEY_k2 };
const setEnv = (v: Record<string, string | undefined>) => {
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
};

before(async () => {
  db = await createTestDb();
  setEnv({ CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: K1, CRM_SECRETS_KEY_k2: undefined });
  for (const id of ['int-a', 'int-b', 'int-c']) await insertIntegration(db.sql, { id, token: null });
});
after(async () => {
  setEnv({ CRM_SECRETS_KID: saved.kid, CRM_SECRETS_KEY_k1: saved.k1, CRM_SECRETS_KEY_k2: saved.k2 });
  await db.close();
});

const rows = () => db.sql<{ integrationId: string; name: string; kid: string; ciphertext: Uint8Array; last4: string }>`
  SELECT integration_id, name, kid, ciphertext, last4 FROM integration_secrets ORDER BY integration_id, name`;

function cli(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  return runSecrets(argv, { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, openDb: async () => async () => {}, env }).then((code) => ({
    code,
    out: out.join('\n'),
    err: err.join('\n'),
  }));
}

test('запись: в БД шифротекст и last4, чтение расшифровывает; перезапись по ключу строки', async () => {
  await putIntegrationSecret(db.sql, { integrationId: 'int-a', name: 'apiKey', plaintext: KEY, now: T0 });
  await putIntegrationSecret(db.sql, { integrationId: 'int-b', name: 'apiKey', plaintext: 'short', now: T0 });
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(all[0]!.kid, 'k1');
  assert.equal(all[0]!.last4, 'abcd');
  assert.equal(all[1]!.last4, '');
  const dump = JSON.stringify(await db.sql`SELECT * FROM integration_secrets`);
  assert.ok(!dump.includes('synthetic-wazzup'), 'значения нет в строке БД');
  assert.ok(!Buffer.from(all[0]!.ciphertext).toString('utf8').includes('synthetic'));
  assert.equal(await getIntegrationSecret(db.sql, { integrationId: 'int-a', name: 'apiKey' }), KEY);
  await putIntegrationSecret(db.sql, { integrationId: 'int-a', name: 'apiKey', plaintext: `${KEY}-new1`, now: T0 + 1 });
  assert.equal(await getIntegrationSecret(db.sql, { integrationId: 'int-a', name: 'apiKey' }), `${KEY}-new1`);
  assert.deepEqual(await describeIntegrationSecrets(db.sql, 'int-a'), [{ name: 'apiKey', last4: 'new1', updatedAt: T0 + 1 }]);
  await assert.rejects(getIntegrationSecret(db.sql, { integrationId: 'int-c', name: 'apiKey' }), (e: SecretError) => e.code === 'not_found');
});

test('строка, перенесённая в чужую интеграцию, не открывается (AAD)', async () => {
  await db.sql`
    INSERT INTO integration_secrets (integration_id, name, kid, iv, ciphertext, tag, last4, updated_at)
    SELECT 'int-c', name, kid, iv, ciphertext, tag, last4, updated_at FROM integration_secrets WHERE integration_id = 'int-a'`;
  await assert.rejects(getIntegrationSecret(db.sql, { integrationId: 'int-c', name: 'apiKey' }), (e: SecretError) => e.code === 'auth_failed');
  assert.equal(await deleteIntegrationSecrets(db.sql, 'int-c'), 1);
  assert.deepEqual(await describeIntegrationSecrets(db.sql, 'int-c'), []);
});

test('контекст плагина: секреты по схеме только при вызове ctx.secrets()', async () => {
  const ctx = buildCtx(deps(), fakeMessenger as never, { id: 'int-a', pluginId: 'messenger.wazzup', spaceId: null, config: {}, enabled: true, status: 'ok', lastEventAt: null, crossborderApprovedAt: T0 });
  assert.equal(JSON.stringify(ctx).includes('synthetic'), false);
  assert.deepEqual(await ctx.secrets(), { apiKey: `${KEY}-new1` });
  assert.equal(ctx.appOrigin, 'https://crm.test');
});

test('crmctl secrets rotate: перешифровка новым kid, --check, старый ключ больше не нужен', async () => {
  const both = { NODE_ENV: 'test', CRM_SECRETS_KID: 'k2', CRM_SECRETS_KEY_k1: K1, CRM_SECRETS_KEY_k2: K2 };
  const before = await cli(['rotate', '--check'], both);
  assert.equal(before.code, 0, before.err);
  assert.match(before.out, /Секретов: 2; открываются: 2; не открываются: 0; на старом ключе: 2/);

  const r = await cli(['rotate'], both);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Перешифровано: 2; не открылось: 0/);
  assert.ok(!r.out.includes('synthetic'));
  assert.deepEqual((await rows()).map((x) => x.kid), ['k2', 'k2']);

  const onlyNew = { NODE_ENV: 'test', CRM_SECRETS_KID: 'k2', CRM_SECRETS_KEY_k2: K2 };
  const check = await cli(['rotate', '--check'], onlyNew);
  assert.equal(check.code, 0, check.err);
  assert.match(check.out, /на старом ключе: 0/);
  const ring = loadKeyring(onlyNew);
  assert.equal(ring.currentKid, 'k2');
  // приложение на новом ключе читает значение
  setEnv({ CRM_SECRETS_KID: 'k2', CRM_SECRETS_KEY_k1: undefined, CRM_SECRETS_KEY_k2: K2 });
  assert.equal(await getIntegrationSecret(db.sql, { integrationId: 'int-b', name: 'apiKey' }), 'short');
  // повтор ротации — ничего не делает
  assert.match((await cli(['rotate'], onlyNew)).out, /Перешифровано: 0; не открылось: 0/);
});

test('crmctl secrets: без ключа — код 1 и только код ошибки; строка не открылась — код 1; неверные аргументы', async () => {
  const noKey = await cli(['rotate'], { NODE_ENV: 'production' });
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /no_key/);
  const wrong = await cli(['rotate', '--check'], { NODE_ENV: 'test', CRM_SECRETS_KID: 'k3', CRM_SECRETS_KEY_k3: randomBytes(32).toString('base64') });
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /не открываются: 2/);
  assert.equal((await cli(['rotate', '--force'], {})).code, 1);
  assert.equal((await cli([], {})).code, 1);
  assert.equal((await cli(['--help'], {})).code, 0);
});
