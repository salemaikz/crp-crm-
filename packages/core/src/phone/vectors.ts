// Общие тест-векторы номеров (замена трёх разошедшихся наборов SalemAI). Все номера синтетические:
// тестовый блок +7 709 …. Векторы, которые проверяют именно префиксы (700, 747, 770, 7172…), берут
// заведомо невыданные номера вида 7XX 000 00 0X — они помечены «[префикс]».

import type { PhoneInvalidReason, PhoneKind } from './types.js';

export interface PhoneExpect {
  digits: string | null;
  kind: PhoneKind;
  working: boolean;
  review?: boolean;
  ext?: string;
  reason?: PhoneInvalidReason;
}

export interface PhoneVector {
  title: string;
  input: string;
  expected: PhoneExpect[];
}

const m = (digits: string, extra: Partial<PhoneExpect> = {}): PhoneExpect => ({
  digits,
  kind: 'mobile',
  working: true,
  ...extra,
});
const l = (digits: string, extra: Partial<PhoneExpect> = {}): PhoneExpect => ({
  digits,
  kind: 'landline',
  working: true,
  ...extra,
});
const bad = (digits: string | null, reason: PhoneInvalidReason): PhoneExpect => ({
  digits,
  kind: 'unknown',
  working: false,
  reason,
});

const A = '77091234567';
const B = '77097654321';

export const PHONE_VECTORS: PhoneVector[] = [
  // --- форматы одного номера ---
  { title: '8 + 10 цифр слитно', input: '87091234567', expected: [m(A)] },
  { title: '8 с пробелами', input: '8 709 123 4567', expected: [m(A)] },
  { title: '8 со скобками и дефисами', input: '8 (709) 123-45-67', expected: [m(A)] },
  { title: '+7 с пробелами', input: '+7 709 123 45 67', expected: [m(A)] },
  { title: '+7 слитно', input: '+77091234567', expected: [m(A)] },
  { title: '+7 со скобками', input: '+7 (709) 123-45-67', expected: [m(A)] },
  { title: '7 без плюса', input: '77091234567', expected: [m(A)] },
  { title: '7 с пробелами', input: '7 709 123 45 67', expected: [m(A)] },
  { title: 'без кода страны, слитно', input: '7091234567', expected: [m(A)] },
  { title: 'без кода страны, со скобками', input: '(709) 123-45-67', expected: [m(A)] },
  { title: 'без кода страны, с пробелами', input: '709 123 45 67', expected: [m(A)] },
  { title: 'точки как разделители', input: '8.709.123.45.67', expected: [m(A)] },
  { title: 'пробелы по краям', input: '   +7 709 123 45 67   ', expected: [m(A)] },
  { title: 'неразрывные пробелы', input: '+7 709 123 45 67', expected: [m(A)] },
  { title: 'число-как-текст с .0 не принимается за 12 цифр', input: '87091234567.0', expected: [bad(null, 'too_long')] },
  // --- префиксы ---
  { title: '[префикс] мобильный 700', input: '+7 700 000 00 01', expected: [m('77000000001')] },
  { title: '[префикс] мобильный 747', input: '+7 747 000 00 02', expected: [m('77470000002')] },
  { title: '[префикс] мобильный 750', input: '+7 750 000 00 03', expected: [m('77500000003')] },
  { title: '[префикс] мобильный 762', input: '+7 762 000 00 04', expected: [m('77620000004')] },
  { title: '[префикс] мобильный 771', input: '+7 771 000 00 05', expected: [m('77710000005')] },
  { title: '[префикс] мобильный 778', input: '+7 778 000 00 06', expected: [m('77780000006')] },
  { title: '[префикс] 770 — мобильный, проверить', input: '+7 770 000 00 07', expected: [m('77700000007', { review: true })] },
  { title: '[префикс] 774 — мобильный, проверить', input: '8 774 000 00 08', expected: [m('77740000008', { review: true })] },
  { title: '[префикс] неизвестный 799 — тип неизвестен, номер рабочий', input: '+7 799 000 00 09', expected: [{ digits: '77990000009', kind: 'unknown', working: true }] },
  { title: '[префикс] городской 7172', input: '+7 (7172) 00-00-01', expected: [l('77172000001')] },
  { title: '[префикс] городской 7172 с восьмёркой', input: '8 7172 00 00 01', expected: [l('77172000001')] },
  { title: '[префикс] городской 727 (7 + 727…)', input: '+7 727 000 00 02', expected: [l('77270000002')] },
  { title: 'городской без кода (7 цифр) — обрывок', input: '12-34-56', expected: [bad(null, 'too_short')] },
  { title: '[префикс] городской без кода страны с кодом города', input: '(7172) 00-00-01', expected: [l('77172000001')] },
  // --- несколько номеров в ячейке ---
  { title: 'два через запятую', input: '8 709 123 4567, +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через точку с запятой', input: '87091234567; 87097654321', expected: [m(A), m(B)] },
  { title: 'два через косую черту', input: '+7 709 123 45 67 / +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через перевод строки', input: '87091234567\n87097654321', expected: [m(A), m(B)] },
  { title: 'два через двойной пробел', input: '+7 709 123 45 67  +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через одиночный пробел', input: '+7 709 123 45 67 +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два слитных через пробел', input: '87091234567 87097654321', expected: [m(A), m(B)] },
  { title: 'два без кода страны через пробел', input: '709 123 45 67 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через «и»', input: '8 709 123 45 67 и 8 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через «И» без пробелов вокруг цифр', input: '87091234567 И 87097654321', expected: [m(A), m(B)] },
  { title: '[префикс] мобильный и городской', input: '+7 709 123 45 67, +7 7172 00 00 01', expected: [m(A), l('77172000001')] },
  { title: 'один номер в двух форматах схлопывается', input: '8 709 123 45 67, +77091234567', expected: [m(A)] },
  { title: 'три номера, средний — пустой фрагмент', input: '87091234567,, 87097654321 ;', expected: [m(A), m(B)] },
  { title: 'текст вместо номера пропускается', input: 'нет, 87091234567', expected: [m(A)] },
  // --- добавочные ---
  { title: 'добавочный «доб.»', input: '+7 709 123-45-67 доб. 123', expected: [m(A, { ext: '123' })] },
  { title: 'добавочный «вн»', input: '+7 709 123-45-67 вн 45', expected: [m(A, { ext: '45' })] },
  { title: 'добавочный «ext»', input: '+7 709 123-45-67 ext. 7', expected: [m(A, { ext: '7' })] },
  { title: 'добавочный отдельным фрагментом', input: '+7 709 123-45-67, доб. 12', expected: [m(A, { ext: '12' })] },
  { title: 'добавочный решёткой', input: '87091234567 #305', expected: [m(A, { ext: '305' })] },
  { title: 'добавочный «x» сразу после цифр', input: '+77091234567x12', expected: [m(A, { ext: '12' })] },
  { title: 'добавочный «доб.» сразу после цифр', input: '87091234567доб.5', expected: [m(A, { ext: '5' })] },
  { title: '[префикс] городской с добавочным', input: '+7 7172 00-00-01 доб. 123', expected: [l('77172000001', { ext: '123' })] },
  // --- заглушки и мусор ---
  { title: '[префикс] заглушка: неизвестный код и одинаковые цифры', input: '+7 799 999 99 99', expected: [bad('77999999999', 'placeholder')] },
  { title: '[префикс] заглушка: неизвестный код, абонентская часть из одной цифры', input: '+7 798 555 55 55', expected: [bad('77985555555', 'placeholder')] },
  { title: 'заглушка (шаблон stubs): абонентский номер из нулей', input: '8 709 000 00 00', expected: [bad('77090000000', 'placeholder')] },
  { title: 'заглушка: одни нули', input: '8 000 000 00 00', expected: [bad('70000000000', 'placeholder')] },
  { title: 'заглушка: одни единицы', input: '+7 111 111 11 11', expected: [bad('71111111111', 'placeholder')] },
  { title: '«красивый» номер не заглушка', input: '+7 709 744 47 77', expected: [m('77097444777')] },
  { title: '«красивый» номер из одинаковых цифр при известном коде — рабочий', input: '+7 709 777 77 77', expected: [m('77097777777')] },
  { title: 'код региона с нуля', input: '+7 009 123 45 67', expected: [bad('70091234567', 'bad_code')] },
  { title: 'код региона с единицы', input: '+7 109 123 45 67', expected: [bad('71091234567', 'bad_code')] },
  { title: 'заглушка и рабочий в одной ячейке', input: '+7 709 000 00 00, +7 709 123 45 67', expected: [bad('77090000000', 'placeholder'), m(A)] },
  { title: 'слишком короткий', input: '12345', expected: [bad(null, 'too_short')] },
  { title: 'девять цифр', input: '709123456', expected: [bad(null, 'too_short')] },
  { title: 'слишком длинный', input: '+7 709 123 45 67 89', expected: [bad(null, 'too_long')] },
  { title: 'иностранный 11 цифр', input: '+1 415 555 01 99', expected: [bad(null, 'foreign')] },
  { title: 'пустая строка', input: '', expected: [] },
  { title: 'только пробелы и разделители', input: ' , ; / ', expected: [] },
  { title: 'только текст', input: 'не указан', expected: [] },
];
