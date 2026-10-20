// Помощники ссылок tel: и wa.me и маски номера для устройства.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digitsOf, formatKzPhone, maskKzPhone, normalizeKzDigits, telHref } from '../../../src/shared/tel';
import { waHref } from '../../../src/shared/whatsapp';

test('номер приводится к 7XXXXXXXXXX из любого написания', () => {
  assert.equal(normalizeKzDigits('8 (709) 555-01-01'), '77095550101');
  assert.equal(normalizeKzDigits('+7 709 555 01 01'), '77095550101');
  assert.equal(normalizeKzDigits('7095550101'), '77095550101');
  assert.equal(normalizeKzDigits('77095550101'), '77095550101');
  assert.equal(digitsOf('a1b2'), '12');
});

test('telHref: международный вид, добавочный через ;ext=, пустой номер — нет ссылки', () => {
  assert.equal(telHref('77095550101'), 'tel:+77095550101');
  assert.equal(telHref('8 709 555 01 01'), 'tel:+77095550101');
  assert.equal(telHref('77095550101', ' 12-3 '), 'tel:+77095550101;ext=123');
  assert.equal(telHref(''), '');
  assert.equal(telHref('abc'), '');
});

test('formatKzPhone и maskKzPhone: показ и закрытая середина', () => {
  assert.equal(formatKzPhone('77095550101'), '+7 709 555 01 01');
  assert.equal(formatKzPhone('12345'), '+12345');
  assert.equal(formatKzPhone(''), '');
  assert.equal(maskKzPhone('77095550167'), '+7 709 ••• •• 67');
  assert.ok(!maskKzPhone('77095550167').includes('555'), 'середина закрыта');
});

test('waHref: текст кодируется целиком, без текста — только номер', () => {
  assert.equal(waHref('77095550101'), 'https://wa.me/77095550101');
  assert.equal(waHref('8 709 555 01 01', 'Здравствуйте & до встречи?'), `https://wa.me/77095550101?text=${encodeURIComponent('Здравствуйте & до встречи?')}`);
  assert.equal(waHref('', 'x'), '');
  assert.equal(waHref('77095550101', '   '), 'https://wa.me/77095550101');
});
