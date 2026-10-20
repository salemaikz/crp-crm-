import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEGAL_FORMS,
  detectLegalForm,
  normalizeBin,
  normalizeCompanyName,
  normalizePersonName,
} from './index.js';

const N = (s: string) => normalizeCompanyName(s);

test('полная и короткая форма, кавычки и дефисы дают один ключ', () => {
  const a = N('Товарищество с ограниченной ответственностью "Концерн "Найза-Қурылыс"');
  assert.equal(a, N('ТОО «Концерн Найза Қурылыс»'));
  assert.equal(a, 'концерн найза курылыс');
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

test('legalFormsFromConfig: однословный алиас до 6 букв — short, остальное — full', async () => {
  const { legalFormsFromConfig, normalizeCompanyName } = await import('./index.js');
  const forms = legalFormsFromConfig([
    { key: 'llp', aliases: ['ТОО', 'Товарищество с ограниченной ответственностью', '  '] },
    { key: 'sp', aliases: ['индивидуальный предприниматель', 'ИП'] },
  ]);
  assert.deepEqual(forms[0], { key: 'llp', full: ['Товарищество с ограниченной ответственностью'], short: ['ТОО'] });
  assert.deepEqual(forms[1]?.short, ['ИП']);
  assert.equal(normalizeCompanyName('ТОО «Пример»', forms), 'пример');
  assert.equal(normalizeCompanyName('Индивидуальный предприниматель Пример', forms), 'пример');
});
