// Секреты интеграций (D-269): AES-256-GCM с AAD integration_id|name|kid, ключи из окружения по kid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DEV_KID, SecretError, hasSecretsKey, last4Of, loadKeyring, openSecret, sealSecret } from '../../../src/server/platform/secrets';

const KEY1 = randomBytes(32).toString('base64');
const KEY2 = randomBytes(32).toString('base64');
const env = (over: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'test', CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: KEY1, ...over });
const SECRET = 'synthetic-api-key-0123456789';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SecretError, 'ошибка — SecretError');
    assert.doesNotMatch(e.message, /synthetic|int-/, 'в тексте ошибки нет значения и имени интеграции');
    return e.code;
  }
  return 'no_error';
};

test('seal → open возвращает значение; шифротекст не содержит его; IV случайный', () => {
  const ring = loadKeyring(env());
  const a = sealSecret(ring, { integrationId: 'int-1', name: 'apiKey', plaintext: SECRET });
  const b = sealSecret(ring, { integrationId: 'int-1', name: 'apiKey', plaintext: SECRET });
  assert.equal(a.kid, 'k1');
  assert.equal(a.iv.length, 12);
  assert.equal(a.tag.length, 16);
  assert.ok(!Buffer.from(a.ciphertext).toString('utf8').includes('synthetic'));
  assert.notDeepEqual(Buffer.from(a.iv), Buffer.from(b.iv));
  assert.equal(openSecret(ring, { integrationId: 'int-1', name: 'apiKey', sealed: a }), SECRET);
});

test('чужая интеграция, чужое имя, порча тега или шифротекста → auth_failed', () => {
  const ring = loadKeyring(env());
  const s = sealSecret(ring, { integrationId: 'int-1', name: 'apiKey', plaintext: SECRET });
  assert.equal(code(() => openSecret(ring, { integrationId: 'int-2', name: 'apiKey', sealed: s })), 'auth_failed');
  assert.equal(code(() => openSecret(ring, { integrationId: 'int-1', name: 'other', sealed: s })), 'auth_failed');
  const tag = new Uint8Array(s.tag);
  tag[0] = (tag[0] as number) ^ 1;
  assert.equal(code(() => openSecret(ring, { integrationId: 'int-1', name: 'apiKey', sealed: { ...s, tag } })), 'auth_failed');
  const ct = new Uint8Array(s.ciphertext);
  ct[0] = (ct[0] as number) ^ 1;
  assert.equal(code(() => openSecret(ring, { integrationId: 'int-1', name: 'apiKey', sealed: { ...s, ciphertext: ct } })), 'auth_failed');
  // подмена kid строки: другой ключ и другой AAD
  const ring2 = loadKeyring(env({ CRM_SECRETS_KEY_k2: KEY2 }));
  assert.equal(code(() => openSecret(ring2, { integrationId: 'int-1', name: 'apiKey', sealed: { ...s, kid: 'k2' } })), 'auth_failed');
});

test('неизвестный kid → unknown_kid; ротация: старый ключ открывает, новый шифрует', () => {
  const old = loadKeyring(env());
  const s = sealSecret(old, { integrationId: 'int-1', name: 'apiKey', plaintext: SECRET });
  const onlyNew = loadKeyring({ NODE_ENV: 'test', CRM_SECRETS_KID: 'k2', CRM_SECRETS_KEY_k2: KEY2 });
  assert.equal(code(() => openSecret(onlyNew, { integrationId: 'int-1', name: 'apiKey', sealed: s })), 'unknown_kid');
  const both = loadKeyring(env({ CRM_SECRETS_KID: 'k2', CRM_SECRETS_KEY_k2: KEY2 }));
  assert.equal(both.currentKid, 'k2');
  assert.equal(openSecret(both, { integrationId: 'int-1', name: 'apiKey', sealed: s }), SECRET);
  const resealed = sealSecret(both, { integrationId: 'int-1', name: 'apiKey', plaintext: SECRET });
  assert.equal(resealed.kid, 'k2');
  assert.equal(openSecret(onlyNew, { integrationId: 'int-1', name: 'apiKey', sealed: resealed }), SECRET);
});

test('production без ключа, без kid, с ключом не 32 байта → no_key; разработка без ключей — тестовый ключ', () => {
  assert.equal(code(() => loadKeyring({ NODE_ENV: 'production' })), 'no_key');
  assert.equal(code(() => loadKeyring({ NODE_ENV: 'production', CRM_SECRETS_KID: 'k1' })), 'no_key');
  assert.equal(code(() => loadKeyring({ NODE_ENV: 'production', CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: randomBytes(16).toString('base64') })), 'no_key');
  assert.equal(code(() => loadKeyring({ NODE_ENV: 'production', CRM_SECRETS_KEY_k1: KEY1 })), 'no_key');
  assert.equal(code(() => loadKeyring({ NODE_ENV: 'test', CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: 'не base64' })), 'no_key');
  assert.equal(hasSecretsKey({ NODE_ENV: 'production' }), false);
  assert.equal(hasSecretsKey({ NODE_ENV: 'production', CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: KEY1 }), true);
  const dev = loadKeyring({ NODE_ENV: 'test' });
  assert.equal(dev.currentKid, DEV_KID);
  const s = sealSecret(dev, { integrationId: 'int-1', name: 'apiKey', plaintext: SECRET });
  // строка, зашифрованная тестовым ключом, на бою не откроется
  const prod = loadKeyring({ NODE_ENV: 'production', CRM_SECRETS_KID: 'k1', CRM_SECRETS_KEY_k1: KEY1 });
  assert.equal(code(() => openSecret(prod, { integrationId: 'int-1', name: 'apiKey', sealed: s })), 'unknown_kid');
});

test('last4: только у значений от 12 символов', () => {
  assert.equal(last4Of('synthetic-key-abcd'), 'abcd');
  assert.equal(last4Of('short-key'), '');
});
