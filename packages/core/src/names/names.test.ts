import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEGAL_FORMS,
  detectLegalForm,
  legalFormCode,
  legalFormOfTypeCell,
  normalizeBin,
  normalizeCompanyName,
  normalizePersonName,
} from './index.js';

const N = (s: string) => normalizeCompanyName(s);

test('полная и короткая форма, кавычки и дефисы дают один ключ', () => {
  const a = N('Товарищество с ограниченной ответственностью "Пример "Гамма-Құрылыс"');
  assert.equal(a, N('ТОО «Пример Гамма Құрылыс»'));
  assert.equal(a, 'пример гамма курылыс');
});

test('ИП, АО, ЖШС, ЖК и латиница', () => {
  assert.equal(N('ИП Иванов А.'), 'иванов а');
  assert.equal(N('Индивидуальный предприниматель Иванов А.'), 'иванов а');
  assert.equal(N('АО «Пример Банк»'), 'пример банк');
  assert.equal(N('Акционерное общество "Пример Банк"'), 'пример банк');
  assert.equal(N('«Пример Сервис» ЖШС'), 'пример сервис');
  assert.equal(N('Жауапкершілігі шектеулі серіктестік «Пример Сервис»'), 'пример сервис');
  assert.equal(N('Жеке кәсіпкер Пример'), 'пример');
  assert.equal(N('Example Trade LLP'), 'example trade');
});

test('регистр, ё/е и казахские буквы', () => {
  assert.equal(N('ТОО «ЕЛКА»'), N('тоо «Ёлка»'));
  assert.equal(N('ТОО «Нұр Әлем»'), N('ТОО «Нур Алем»'));
  assert.equal(N('ТОО «ҚАЗЫНА ҒИМАРАТ»'), 'казына гимарат');
});

test('форма без пробела и слитные кавычки', () => {
  assert.equal(N('ТОО"Пример Строй"'), 'пример строй');
  assert.equal(N('ТОО Пример Строй'), N('Пример строй, ТОО'));
});

test('слово внутри названия не режется: «Тоотар» и «Типография»', () => {
  assert.equal(N('ТОО Тоотар'), 'тоотар');
  assert.equal(N('Типография Ап'), 'типография ап');
});

test('пустой ввод и название из одной формы', () => {
  assert.equal(N(''), '');
  assert.equal(normalizeCompanyName(null), '');
  assert.equal(N('ТОО'), '');
  assert.equal(N('  «  »  '), '');
});

test('формы собственности — параметр: пустой список ничего не удаляет', () => {
  assert.equal(normalizeCompanyName('ТОО «Пример»', []), 'тоо пример');
  const custom = [{ key: 'ltd', full: ['company limited'], short: ['ltd'] }];
  assert.equal(normalizeCompanyName('Example Company Limited', custom), 'example');
  assert.equal(normalizeCompanyName('ТОО Example', custom), 'тоо example');
});

test('detectLegalForm: полная, короткая, нет формы', () => {
  assert.equal(detectLegalForm('ИП Иванов'), 'sole_proprietor');
  assert.equal(detectLegalForm('Индивидуальный предприниматель Иванов'), 'sole_proprietor');
  assert.equal(detectLegalForm('ТОО «Пример»'), 'llp');
  assert.equal(detectLegalForm('Пример АО'), 'jsc');
  assert.equal(detectLegalForm('Пример'), null);
  assert.equal(detectLegalForm('ТОО Пример', []), null);
  assert.ok(DEFAULT_LEGAL_FORMS.length >= 3);
});

test('«ЖК» в названии — не ИП (жилой комплекс); ИП по-казахски — только полной формой', () => {
  assert.equal(detectLegalForm('ЖК «Альфа Парк»'), null);
  assert.equal(detectLegalForm('Альфа Парк ЖК'), null);
  assert.equal(N('ЖК «Альфа Парк»'), 'жк альфа парк', '«ЖК» из названия не вырезается');
  assert.equal(detectLegalForm('Жеке кәсіпкер Гамма'), 'sole_proprietor');
  assert.equal(detectLegalForm('ЖК Жеке кәсіпкер Гамма'), 'sole_proprietor');
});

test('колонка «Тип»: полные, короткие и казахские формы, точки и регистр', () => {
  const T = (s: string) => legalFormOfTypeCell(s);
  for (const v of ['ИП', 'ип', 'ИП.', ' ИП ', 'Индивидуальный предприниматель', 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', 'ЖК', 'Жеке кәсіпкер', 'жеке касипкер']) {
    assert.equal(T(v), 'sole_proprietor', v);
  }
  assert.equal(T('ТОО'), 'llp');
  assert.equal(T('Товарищество с ограниченной ответственностью'), 'llp');
  assert.equal(T('ЖШС'), 'llp');
  assert.equal(T('АО'), 'jsc');
  assert.equal(T('Крестьянское хозяйство'), null);
  assert.equal(T(''), null);
  assert.equal(legalFormCode('sole_proprietor'), 'ип');
  assert.equal(legalFormCode('llp'), 'тоо');
  assert.equal(legalFormCode(null), '');
});

test('normalizePersonName: регистр, ё, казахские буквы, знаки', () => {
  assert.equal(normalizePersonName('  Петров-Ёлкин, А. Б.'), 'петров елкин а б');
  assert.equal(normalizePersonName('Нұрғалиев Ғалым'), 'нургалиев галым');
  assert.equal(normalizePersonName(null), '');
});

test('normalizeBin: ровно 12 цифр', () => {
  assert.equal(normalizeBin('123456789012'), '123456789012');
  assert.equal(normalizeBin('12 3456 789012'), '123456789012');
  assert.equal(normalizeBin('12345678901'), '');
  assert.equal(normalizeBin('1234567890123'), '');
  assert.equal(normalizeBin(undefined), '');
});
