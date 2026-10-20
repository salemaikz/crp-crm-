import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PHONE_RULES, matchesPrefix, normalizePhone, parsePhone, splitPhones } from './index.js';
import type { PhoneRules } from './index.js';
import { PHONE_VECTORS } from './vectors.js';

test('набор тест-векторов не меньше 40', () => {
  assert.ok(PHONE_VECTORS.length >= 40, `векторов: ${PHONE_VECTORS.length}`);
});

for (const v of PHONE_VECTORS) {
  test(`splitPhones: ${v.title}`, () => {
    const got = splitPhones(v.input, DEFAULT_PHONE_RULES).map((p) => ({
      digits: p.digits,
      kind: p.kind,
      working: p.working,
      review: p.needsReview,
      ext: p.ext,
      reason: p.invalidReason,
    }));
    const want = v.expected.map((e) => ({
      digits: e.digits,
      kind: e.kind,
      working: e.working,
      review: e.review ?? false,
      ext: e.ext ?? '',
      reason: e.reason ?? null,
    }));
    assert.deepEqual(got, want);
  });
}

test('e164 и raw рабочего номера', () => {
  const p = parsePhone(' 8 709 123 45 67 ', DEFAULT_PHONE_RULES)!;
  assert.equal(p.e164, '+77091234567');
  assert.equal(p.raw, '8 709 123 45 67');
});

test('parsePhone: null, если цифр нет', () => {
  assert.equal(parsePhone(null, DEFAULT_PHONE_RULES), null);
  assert.equal(parsePhone('нет', DEFAULT_PHONE_RULES), null);
});

test('normalizePhone: рабочий номер или null; восьмёрка и +7 совпадают (ключ дедупа)', () => {
  assert.equal(normalizePhone('87091234567', DEFAULT_PHONE_RULES), '77091234567');
  assert.equal(normalizePhone('87091234567', DEFAULT_PHONE_RULES), normalizePhone('+7 709 123 45 67', DEFAULT_PHONE_RULES));
  assert.equal(normalizePhone('+7 709 000 00 00', DEFAULT_PHONE_RULES), null);
  assert.equal(normalizePhone('+7 709 777 77 77', DEFAULT_PHONE_RULES), '77097777777', '«красивый» номер рабочий');
  assert.equal(normalizePhone(undefined, DEFAULT_PHONE_RULES), null);
});

test('невалидные дубли в ячейке не склеиваются между собой, если разные', () => {
  const r = splitPhones('123, 456', DEFAULT_PHONE_RULES);
  assert.equal(r.length, 2);
  assert.equal(splitPhones('123, 123', DEFAULT_PHONE_RULES).length, 1);
});

test('matchesPrefix: x — любая цифра, длина префикса не больше номера', () => {
  assert.ok(matchesPrefix('7172123456', '71x'));
  assert.ok(matchesPrefix('7172123456', '7172'));
  assert.ok(!matchesPrefix('7272123456', '71x'));
  assert.ok(!matchesPrefix('709', '7091234567'));
  assert.ok(!matchesPrefix('7091234567', ''));
});

test('правила из настроек: свои префиксы и заглушки меняют тип и рабочесть', () => {
  const rules: PhoneRules = {
    country: 'KZ',
    mobilePrefixes: ['709'],
    reviewPrefixes: ['709'],
    landlinePrefixes: ['7172'],
    stubs: ['77091111112', '7709xxx0000'],
  };
  const review = parsePhone('+7 709 123 45 67', rules)!;
  assert.equal(review.kind, 'mobile');
  assert.equal(review.needsReview, true, 'review важнее mobile');
  assert.equal(parsePhone('+7 747 000 00 01', rules)!.kind, 'unknown'); // [префикс] невыданный номер
  const stub = parsePhone('+7 709 111 11 12', rules)!;
  assert.equal(stub.working, false);
  assert.equal(stub.invalidReason, 'placeholder');
  assert.equal(parsePhone('+7 709 123 00 00', rules)!.invalidReason, 'placeholder', 'шаблон с x');
  assert.equal(parsePhone('+7 709 123 00 01', rules)!.working, true);
  // Без шаблонов в настройках «нули» после известного кода — рабочий номер.
  assert.equal(parsePhone('+7 709 000 00 00', { ...rules, stubs: [] })!.working, true);
});

test('два номера через пробел режутся, только если режутся без остатка', () => {
  const r = splitPhones('+7 709 123 45 67 89', DEFAULT_PHONE_RULES);
  assert.deepEqual(r.map((p) => p.invalidReason), ['too_long']);
  const three = splitPhones('87091234567 87097654321 87090001122', DEFAULT_PHONE_RULES);
  assert.deepEqual(three.map((p) => p.digits), ['77091234567', '77097654321', '77090001122']);
});

test('в векторах нет живых номеров: блок 709, а префиксы — только невыданные 7XX 000 00 0X', () => {
  for (const v of PHONE_VECTORS) {
    for (const e of v.expected) {
      if (!e.digits || !e.working) continue;
      const blank = /^7\d{3}0{6}\d$/.test(e.digits) || /^7\d{4}0{5}\d$/.test(e.digits);
      assert.ok(e.digits.startsWith('7709') || (blank && v.title.startsWith('[префикс]')), `${v.title}: ${e.digits}`);
    }
  }
});
