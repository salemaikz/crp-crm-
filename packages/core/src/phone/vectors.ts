// Общие тест-векторы номеров (замена трёх разошедшихся наборов SalemAI). Все номера
// синтетические: +7 709 …, 747, 700-блок, городские 7172 с вымышленным абонентом.

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
  { title: 'мобильный 700', input: '+7 700 123 45 67', expected: [m('77001234567')] },
  { title: 'мобильный 747', input: '+7 747 123 45 67', expected: [m('77471234567')] },
  { title: 'мобильный 750', input: '+7 750 123 45 67', expected: [m('77501234567')] },
  { title: 'мобильный 762', input: '+7 762 123 45 67', expected: [m('77621234567')] },
  { title: 'мобильный 771', input: '+7 771 123 45 67', expected: [m('77711234567')] },
  { title: 'мобильный 778', input: '+7 778 123 45 67', expected: [m('77781234567')] },
  { title: '770 — мобильный, проверить', input: '+7 770 123 45 67', expected: [m('77701234567', { review: true })] },
  { title: '774 — мобильный, проверить', input: '8 774 123 45 67', expected: [m('77741234567', { review: true })] },
  { title: 'неизвестный префикс 701-соседа 799 — тип неизвестен, номер рабочий', input: '+7 799 123 45 67', expected: [{ digits: '77991234567', kind: 'unknown', working: true }] },
  { title: 'городской 7172', input: '+7 (7172) 12-34-56', expected: [l('77172123456')] },
  { title: 'городской 7172 с восьмёркой', input: '8 7172 12 34 56', expected: [l('77172123456')] },
  { title: 'городской 727 (7 + 727…)', input: '+7 727 123 45 67', expected: [l('77271234567')] },
  { title: 'городской без кода (7 цифр) — обрывок', input: '12-34-56', expected: [bad(null, 'too_short')] },
  { title: 'городской без кода страны с кодом города', input: '(7172) 12-34-56', expected: [l('77172123456')] },
  // --- несколько номеров в ячейке ---
  { title: 'два через запятую', input: '8 709 123 4567, +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через точку с запятой', input: '87091234567; 87097654321', expected: [m(A), m(B)] },
  { title: 'два через косую черту', input: '+7 709 123 45 67 / +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'два через перевод строки', input: '87091234567\n87097654321', expected: [m(A), m(B)] },
  { title: 'два через двойной пробел', input: '+7 709 123 45 67  +7 709 765 43 21', expected: [m(A), m(B)] },
  { title: 'мобильный и городской', input: '+7 709 123 45 67, +7 7172 12 34 56', expected: [m(A), l('77172123456')] },
  { title: 'один номер в двух форматах схлопывается', input: '8 709 123 45 67, +77091234567', expected: [m(A)] },
  { title: 'три номера, средний — пустой фрагмент', input: '87091234567,, 87097654321 ;', expected: [m(A), m(B)] },
  { title: 'текст вместо номера пропускается', input: 'нет, 87091234567', expected: [m(A)] },
  // --- добавочные ---
  { title: 'добавочный «доб.»', input: '+7 7172 12-34-56 доб. 123', expected: [l('77172123456', { ext: '123' })] },
  { title: 'добавочный «вн»', input: '+7 7172 12-34-56 вн 45', expected: [l('77172123456', { ext: '45' })] },
  { title: 'добавочный «ext»', input: '+7 7172 12-34-56 ext. 7', expected: [l('77172123456', { ext: '7' })] },
  { title: 'добавочный отдельным фрагментом', input: '+7 7172 12-34-56, доб. 12', expected: [l('77172123456', { ext: '12' })] },
  { title: 'добавочный решёткой', input: '87172123456 #305', expected: [l('77172123456', { ext: '305' })] },
  // --- заглушки и мусор ---
  { title: 'заглушка: все цифры одинаковые', input: '+7 777 777 77 77', expected: [bad('77777777777', 'placeholder')] },
  { title: 'заглушка: абонентский номер из нулей', input: '+7 701 000 00 00', expected: [bad('77010000000', 'placeholder')] },
  { title: 'заглушка: 000 00 00 после кода 709', input: '8 709 000 00 00', expected: [bad('77090000000', 'placeholder')] },
  { title: 'заглушка: одни нули', input: '8 000 000 00 00', expected: [bad('70000000000', 'placeholder')] },
  { title: 'заглушка: одни единицы', input: '+7 111 111 11 11', expected: [bad('71111111111', 'placeholder')] },
  { title: '«красивый» номер не заглушка', input: '+7 747 744 47 77', expected: [m('77477444777')] },
  { title: 'код региона с нуля', input: '+7 009 123 45 67', expected: [bad('70091234567', 'bad_code')] },
  { title: 'код региона с единицы', input: '+7 109 123 45 67', expected: [bad('71091234567', 'bad_code')] },
  { title: 'заглушка и рабочий в одной ячейке', input: '+7 777 777 77 77, +7 709 123 45 67', expected: [bad('77777777777', 'placeholder'), m(A)] },
  { title: 'слишком короткий', input: '12345', expected: [bad(null, 'too_short')] },
  { title: 'девять цифр', input: '709123456', expected: [bad(null, 'too_short')] },
  { title: 'слишком длинный', input: '+7 709 123 45 67 89', expected: [bad(null, 'too_long')] },
  { title: 'иностранный 11 цифр', input: '+1 415 555 01 99', expected: [bad(null, 'foreign')] },
  { title: 'пустая строка', input: '', expected: [] },
  { title: 'только пробелы и разделители', input: ' , ; / ', expected: [] },
  { title: 'только текст', input: 'не указан', expected: [] },
];
