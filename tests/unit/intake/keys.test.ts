// Ключи приёма: формат, разбор (секрет base64url может содержать «_»), хэш и сравнение; канонический хэш тела.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, requestHash } from '../../../src/server/domain/intake/canonical';
import { bearerOf, generateKey, hashSecret, parseKey, secretMatches } from '../../../src/server/domain/intake/keys';

test('ключ: crm1_<8 символов>_<43 символа base64url>, в хэше — sha256 секрета', () => {
  const g = generateKey();
  assert.match(g.key, /^crm1_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
  const p = parseKey(g.key);
  assert.ok(p);
  assert.equal(p.prefix, g.prefix);
  assert.equal(hashSecret(p.secret), g.keyHash);
  assert.match(g.keyHash, /^[0-9a-f]{64}$/);
  assert.ok(!g.keyHash.includes(p.secret));
  assert.notEqual(generateKey().key, g.key);
});

test('разбор ключа: секрет с «_» и «-» не ломает prefix', () => {
  const secret = `_${'a-'.repeat(20)}a_`;
  assert.equal(secret.length, 43);
  assert.deepEqual(parseKey(`crm1_ab12cd34_${secret}`), { prefix: 'ab12cd34', secret });
  for (const bad of ['', 'crm1_ab12cd34', 'crm2_ab12cd34_' + 'A'.repeat(43), 'crm1_AB12CD34_' + 'A'.repeat(43), 'crm1_ab12cd3_' + 'A'.repeat(43), 'crm1_ab12cd34_' + 'A'.repeat(42), 'crm1_ab12cd34_' + 'A'.repeat(44)]) {
    assert.equal(parseKey(bad), null, bad);
  }
});

test('Authorization: Bearer', () => {
  assert.equal(bearerOf('Bearer abc'), 'abc');
  assert.equal(bearerOf('bearer   abc '), 'abc');
  for (const bad of [null, undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', 'abc']) assert.equal(bearerOf(bad), null);
});

test('сравнение секрета с хэшем', () => {
  const g = generateKey();
  const p = parseKey(g.key)!;
  assert.equal(secretMatches(p.secret, g.keyHash), true);
  assert.equal(secretMatches(p.secret + 'x', g.keyHash), false);
  assert.equal(secretMatches(p.secret, '0'.repeat(64)), false);
  assert.equal(secretMatches(p.secret, 'не-hex'), false);
});

test('канонический JSON: порядок ключей не важен, undefined пропускается, массивы упорядочены', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } }), '{"a":{"d":[1,2]},"b":1}');
  assert.equal(requestHash({ a: 1, b: [1, 2] }), requestHash({ b: [1, 2], a: 1 }));
  assert.notEqual(requestHash({ b: [1, 2] }), requestHash({ b: [2, 1] }));
  assert.notEqual(requestHash({ a: 1 }), requestHash({ a: '1' }));
});
