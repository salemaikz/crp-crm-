import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../../../src/shared/safeNext';
import { formatPhoneInput, nationalDigits } from '../../../src/shared/phoneMask';

test('safeNext: относительные пути проходят', () => {
  assert.equal(safeNext('/leads'), '/leads');
  assert.equal(safeNext('/leads/1?x=1#q'), '/leads/1?x=1#q');
  assert.equal(safeNext('/a/../leads'), '/leads');
  assert.equal(safeNext('/'), '/');
});

test('safeNext: внешние и подозрительные адреса отклоняются', () => {
  for (const bad of [
    'https://evil.com', 'http://evil.com/x', '//evil.com', '///evil.com', '/\\evil.com', '\\\\evil.com',
    '/\t/evil.com', '/\n/evil.com', ' /leads', 'javascript:alert(1)', 'leads', '', '/' + 'a'.repeat(3000),
  ]) {
    assert.equal(safeNext(bad), null, bad);
  }
  assert.equal(safeNext(null), null);
  assert.equal(safeNext(42), null);
  const out = safeNext('/..//evil.com');
  assert.ok(out === null || (out.startsWith('/') && !out.startsWith('//')), String(out));
});

test('маска номера: 8…, +7…, вставка с пробелами и 10 цифр без кода страны', () => {
  assert.equal(formatPhoneInput('87095550123'), '+7 (709) 555-01-23');
  assert.equal(formatPhoneInput('+7 709 555 01 23'), '+7 (709) 555-01-23');
  assert.equal(formatPhoneInput('709 555 01 23'), '+7 (709) 555-01-23');
  assert.equal(formatPhoneInput('7095550123'), '+7 (709) 555-01-23');
  assert.equal(formatPhoneInput('77095550123'), '+7 (709) 555-01-23');
  assert.equal(formatPhoneInput(''), '');
  assert.equal(formatPhoneInput('8'), '+7');
  assert.equal(formatPhoneInput('+7 (70'), '+7 (70');
  assert.equal(formatPhoneInput('+7 (709) 555-01-23999'), '+7 (709) 555-01-23');
  assert.equal(nationalDigits('8 709 555 01 23'), '7095550123');
});
