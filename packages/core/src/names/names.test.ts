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
  assert.equal(detectLegalForm('ИП Иванов'), 'ip');
  assert.equal(detectLegalForm('Индивидуальный предприниматель Иванов'), 'ip');
  assert.equal(detectLegalForm('ТОО «Пример»'), 'too');
  assert.equal(detectLegalForm('Пример АО'), 'ao');
  assert.equal(detectLegalForm('Пример'), null);
  assert.equal(detectLegalForm('ТОО Пример', []), null);
  assert.ok(DEFAULT_LEGAL_FORMS.length >= 3);
});

test('«ЖК» в названии — не ИП (жилой комплекс); ИП по-казахски — только полной формой', () => {
  assert.equal(detectLegalForm('ЖК «Альфа Парк»'), null);
  assert.equal(detectLegalForm('Альфа Парк ЖК'), null);
  assert.equal(N('ЖК «Альфа Парк»'), 'жк альфа парк', '«ЖК» из названия не вырезается');
  assert.equal(detectLegalForm('Жеке кәсіпкер Гамма'), 'ip');
  assert.equal(detectLegalForm('ЖК Жеке кәсіпкер Гамма'), 'ip');
});

test('колонка «Тип»: полные, короткие и казахские формы, точки и регистр', () => {
  const T = (s: string) => legalFormOfTypeCell(s);
  for (const v of ['ИП', 'ип', 'ИП.', ' ИП ', 'Индивидуальный предприниматель', 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', 'ЖК', 'Жеке кәсіпкер', 'жеке касипкер']) {
    assert.equal(T(v), 'ip', v);
  }
  assert.equal(T('ТОО'), 'too');
  assert.equal(T('Товарищество с ограниченной ответственностью'), 'too');
  assert.equal(T('ЖШС'), 'too');
  assert.equal(T('АО'), 'ao');
  assert.equal(T('IP'), 'ip');
  assert.equal(T('Т.О.О.'), 'too');
  assert.equal(T('Крестьянское хозяйство'), 'kh');
  assert.equal(T('ГКП'), 'gkp');
  assert.equal(T('ГУ'), 'gu');
  assert.equal(T('ОО'), 'oo');
  assert.equal(T('ПК'), 'pk');
  assert.equal(T('Форма-Икс'), null);
  assert.equal(T(''), null);
  // «ПК» и «IP» — только в «Тип»: в названии это не форма.
  assert.equal(detectLegalForm('Сервис ПК'), null);
  assert.equal(detectLegalForm('IP Телеком'), null);
  assert.equal(legalFormCode('pk'), 'пк');
  assert.equal(legalFormCode('ip'), 'ип');
  assert.equal(legalFormCode('too'), 'тоо');
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
