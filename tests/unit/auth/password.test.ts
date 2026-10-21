import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, passwordProblem, verifyPassword, needsRehash } from '../../../src/server/platform/auth/password';

const PHONE = '77095550123';

test('длина: 7 символов мало, 8 хватает', () => {
  assert.equal(passwordProblem('Abcde1x', PHONE), 'too_short');
  assert.equal(passwordProblem('Abcde1xy', PHONE), null);
});

test('72 байта UTF-8 допустимы, 73 — too_long (кириллица — 2 байта)', () => {
  assert.equal(passwordProblem('ж'.repeat(36), PHONE), 'too_common'); // 72 байта, одна буква
  assert.equal(passwordProblem('жк'.repeat(18), PHONE), null);
  assert.equal(passwordProblem(`${'жк'.repeat(18)}a`, PHONE), 'too_long');
});

test('частые пароли без учёта регистра и повторы одного знака', () => {
  assert.equal(passwordProblem('QWERTY123', PHONE), 'too_common');
  assert.equal(passwordProblem('Password1', PHONE), 'too_common');
  assert.equal(passwordProblem('Йцукенг123', PHONE), 'too_common');
  assert.equal(passwordProblem('11111111', PHONE), 'too_common');
  assert.equal(passwordProblem('aaaaaaaaaa', PHONE), 'too_common');
  assert.equal(passwordProblem('12345678', PHONE), 'too_common');
});

test('пароль = номер: полный канон, последние 10 цифр, с 8', () => {
  assert.equal(passwordProblem('77095550123', PHONE), 'same_as_phone');
  assert.equal(passwordProblem('7095550123', PHONE), 'same_as_phone');
  assert.equal(passwordProblem('87095550123', PHONE), 'same_as_phone');
  assert.equal(passwordProblem('+7 709 555 01 23', PHONE), 'same_as_phone');
  assert.equal(passwordProblem('7095550124', PHONE), null);
});

test('bcrypt: хеш сверяется, чужой пароль и пустой хеш — false', async () => {
  const hash = await hashPassword('Коротко-и-ясно-42');
  assert.equal(await verifyPassword('Коротко-и-ясно-42', hash), true);
  assert.equal(await verifyPassword('другой-пароль-42', hash), false);
  assert.equal(await verifyPassword('любой', null), false);
  assert.equal(await verifyPassword('любой', 'не-хеш'), false);
  assert.equal(needsRehash(hash), false);
  assert.equal(needsRehash('$2b$04$2IHD0qzl/PzLqK.0LzNYQuM4cDz5OVT71kxsRMjzdcLLRyWEj8oru'), true);
});

test('время сверки с несуществующим номером сопоставимо с настоящим (bcrypt по фиктивному хешу)', async () => {
  const hash = await hashPassword('Коротко-и-ясно-42');
  const t0 = performance.now();
  await verifyPassword('x', hash);
  const real = performance.now() - t0;
  const t1 = performance.now();
  await verifyPassword('x', null);
  const dummy = performance.now() - t1;
  assert.ok(dummy > real * 0.4, `dummy ${dummy} real ${real}`);
});
