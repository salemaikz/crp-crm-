// Свойство: ключ строки и ключ состояния импорта не зависят от порядка колонок в таблице (D-048).
// Детерминированный генератор с seed, без новых зависимостей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProfile, parseSheet } from './parse';
import { normalizers, testHash, testProfile } from './testProfile';

const CASES = 2500;

/** mulberry32: маленький детерминированный генератор. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

const profile = testProfile([{ label: 'Оператор-01 (Синий)', name: 'Оператор-01', color: 'Синий', ranges: [[1, 100000]] }]);
const cp = compileProfile(profile);
const HEADERS = Object.keys(profile.columns);
const EXTRA = ['Комментарий', 'Дата', '№'];

const shuffle = <T>(r: Rng, xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const NAMES = ['Альфа', 'Қала-Строй', 'Ёлка', 'Бета Групп', 'Нур-Сервис', 'Zeta Trade'];
const word = (r: Rng) => r.pick(NAMES);
const phone = (r: Rng) => r.pick(['8 705 ', '+7 (707) ', '8 777 ', '8 7172 ', '700 ']) + String(r.int(1000000, 9999999));

function genRow(r: Rng): Record<string, string> {
  const form = r.pick(['ТОО', 'ИП', 'АО', '']);
  return {
    Тип: r.chance(0.5) ? form : '',
    Наименование: r.chance(0.5) ? `${form} «${word(r)}»` : `${word(r)}  ${r.int(1, 99)}`,
    Регион: r.pick(['Регион-1', 'Регион-2', '']),
    Руководитель: r.chance(0.7) ? `${word(r)} ${r.pick(['А.', 'Б.Б.', ''])}` : '',
    ОКЭД: String(r.int(10000, 99999)),
    Телефон: Array.from({ length: r.int(1, 3) }, () => phone(r)).join(r.pick([', ', '; ', '\n'])),
    Адрес: r.chance(0.5) ? 'ул. Тестовая 1' : '',
    'ЛПР подтвержден': r.pick(['да', 'нет', '']),
    Ответ: r.pick(['', 'Перезвонить', 'Отключен/Не берет, Перезвонить', 'Закрылся', 'Подтвержден', 'что-то новое']),
    Статус: r.pick(['', 'Целевой', 'не целевой']),
    'Точная ниша': r.pick(['', 'Логистика', ' Логистика ']),
    Заметка: r.pick(['', 'набрать 14.10', '  пробелы  внутри ', 'не звонить']),
    Комментарий: 'x',
    Дата: '2026-10-01',
    '№': String(r.int(1, 99)),
  };
}

function parse(headers: readonly string[], rows: readonly Record<string, string>[]) {
  const grid = [['Таблица оператора'], [...headers], ...rows.map((row) => headers.map((h) => row[h] ?? ''))];
  const res = parseSheet(grid, cp, { normalizers, hash: testHash });
  assert.ok(res.ok, 'заголовки не найдены');
  return res.ok ? res.rows : [];
}

test(`свойство: ключи строки и состояния не зависят от порядка колонок (${CASES} таблиц)`, () => {
  const r = rng(501);
  for (let i = 0; i < CASES; i++) {
    const rows = Array.from({ length: r.int(1, 4) }, () => genRow(r));
    const headers = [...HEADERS, ...EXTRA.filter(() => r.chance(0.5))];
    const a = parse(shuffle(r, headers), rows);
    const b = parse(shuffle(r, headers), rows);
    assert.equal(a.length, b.length, `таблица ${i}: число строк`);
    a.forEach((row, k) => {
      const other = b[k]!;
      const ctx = `таблица ${i}, строка ${k}: ${JSON.stringify(rows[k])}`;
      assert.equal(row.rowKey, other.rowKey, `${ctx}\nrowKey зависит от порядка колонок`);
      assert.equal(row.stateKey, other.stateKey, `${ctx}\nstateKey зависит от порядка колонок`);
    });
  }
});

test(`свойство: порядок номеров в ячейке не меняет ключ строки (${CASES} таблиц)`, () => {
  const r = rng(502);
  for (let i = 0; i < CASES; i++) {
    const row = genRow(r);
    const parts = row['Телефон']!.split(/[,;\n]\s*/);
    const swapped = { ...row, Телефон: shuffle(r, parts).join('; ') };
    const [a] = parse(HEADERS, [row]);
    const [b] = parse(HEADERS, [swapped]);
    assert.equal(a?.rowKey, b?.rowKey, `таблица ${i}: ${JSON.stringify(row['Телефон'])} vs ${JSON.stringify(swapped.Телефон)}`);
  }
});
