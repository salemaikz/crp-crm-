// Данные календаря слоя kz (presets/kz/preset.json): формат CONFIG §6.2, согласованность с правилом ст. 85 ТК РК
// и с производственным календарём Минтруда на 2026 год. Источники и оговорки — presets/kz/CALENDAR.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLocalDays, createWorkCalendar, isoWeekday, isValidDay } from '../../../packages/core/src/time';
import { read } from '../../helpers/sourceFiles';
import { kzSettings, loadKzPreset } from './_kz';

const preset = loadKzPreset();
const rows = preset.global.calendar.holidays;
const inYear = (y: number) => rows.filter((r) => r.date.startsWith(`${y}-`));
const isWeekend = (d: string) => isoWeekday(d) >= 6;
const MARKER = 'переносы 2027 — не опубликованы';

test('мета слоя и формат строк: дата, вид, примечание', () => {
  assert.equal(preset.meta.key, 'kz');
  assert.match(preset.meta.version, /^\d{4}\.\d{1,2}\.\d+$/);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(isValidDay(r.date), `дата ${r.date}`);
    assert.ok(['holiday', 'workday'].includes(r.kind), `вид ${r.date}`);
    assert.ok(typeof r.note === 'string' && r.note.length > 0, `примечание ${r.date}`);
    assert.deepEqual(Object.keys(r).sort(), ['date', 'kind', 'note']);
  }
});

test('даты уникальны (ключ слияния), отсортированы и охватывают 2026–2027', () => {
  const dates = rows.map((r) => r.date);
  assert.equal(new Set(dates).size, dates.length);
  assert.deepEqual([...dates].sort(), dates);
  assert.ok(inYear(2026).length > 0 && inYear(2027).length > 0);
  assert.equal(inYear(2026).length + inYear(2027).length, rows.length);
});

test('указанные в примечаниях дни недели совпадают с датами', () => {
  for (const r of rows) {
    const sat = /\((?:[^)]*, )?суббота\b/.test(r.note) || /\(суббота\)/.test(r.note);
    const sun = /\((?:[^)]*, )?воскресенье\b/.test(r.note) || /\(воскресенье\)/.test(r.note);
    // «Перенос с 08.03 (воскресенье)» — день недели относится к исходной дате, её проверяет следующий тест
    if (r.note.startsWith('Перенос с')) continue;
    if (sat) assert.equal(isoWeekday(r.date), 6, `${r.date}: ${r.note}`);
    if (sun) assert.equal(isoWeekday(r.date), 7, `${r.date}: ${r.note}`);
  }
});

// Официальные переносы 2026 (пятидневка): производственный календарь Минтруда, ред. от 01.07.2026.
const OFFICIAL_2026_TRANSFERS: Array<[from: string, to: string]> = [
  ['2026-03-08', '2026-03-09'],
  ['2026-03-21', '2026-03-24'],
  ['2026-03-22', '2026-03-25'],
  ['2026-05-09', '2026-05-11'],
  ['2026-10-25', '2026-10-26'],
];

test('2026: переносы совпадают с календарём Минтруда', () => {
  const transfers = inYear(2026).filter((r) => r.note.startsWith('Перенос с'));
  assert.deepEqual(
    transfers.map((r) => r.date),
    OFFICIAL_2026_TRANSFERS.map(([, to]) => to),
  );
  for (const [from, to] of OFFICIAL_2026_TRANSFERS) {
    const src = rows.find((r) => r.date === from);
    assert.ok(src && src.kind === 'holiday', `исходный праздник ${from} внесён`);
    assert.ok(isWeekend(from), `${from} выпадает на выходной`);
    assert.ok(!isWeekend(to), `${to} — будний день`);
    const dd = from.slice(8) + '.' + from.slice(5, 7);
    assert.match(rows.find((r) => r.date === to)?.note ?? '', new RegExp(`Перенос с ${dd}`), `примечание ${to}`);
  }
});

/** Правило ст. 85 п. 3 ТК РК: праздник на выходной → выходным становится следующий рабочий день, не занятый другим праздником. */
function expectedArt85Transfers(year: number): string[] {
  const holidayDates = new Set(inYear(year).filter((r) => !r.note.startsWith('Перенос с') && !/Курбан/.test(r.note)).map((r) => r.date));
  const kurban = new Set(inYear(year).filter((r) => /Курбан/.test(r.note)).map((r) => r.date));
  const taken = new Set<string>();
  const out: string[] = [];
  for (const d of [...holidayDates].sort()) {
    if (!isWeekend(d)) continue;
    let t = addLocalDays(d, 1);
    while (isWeekend(t) || holidayDates.has(t) || kurban.has(t) || taken.has(t)) t = addLocalDays(t, 1);
    taken.add(t);
    out.push(t);
  }
  return out.sort();
}

test('2026: правило ст. 85 ТК даёт ровно внесённые переносы (проверка правила и данных друг другом)', () => {
  const entered = inYear(2026).filter((r) => r.note.startsWith('Перенос с')).map((r) => r.date);
  assert.deepEqual(expectedArt85Transfers(2026), entered);
});

test('2026: 247 рабочих дней при пятидневке (Минтруд, ред. 01.07.2026: 247 дней, 1976 часов)', () => {
  const cal = createWorkCalendar(kzSettings());
  let n = 0;
  for (let d = '2026-01-01'; d <= '2026-12-31'; d = addLocalDays(d, 1)) if (cal.isWorkday(d)) n++;
  assert.equal(n, 247);
  assert.equal(n * 8, 1976);
});

test('2027: только праздники по закону; пока переносов нет, у строк на выходной стоит пометка «переносы 2027 — не опубликованы»', () => {
  const r27 = inYear(2027);
  const transfers = r27.filter((r) => r.note.startsWith('Перенос с'));
  if (transfers.length === 0) {
    const weekendRows = r27.filter((r) => isWeekend(r.date));
    assert.ok(weekendRows.length >= 4);
    for (const r of weekendRows) assert.ok(r.note.includes(MARKER), `${r.date}: нет пометки`);
  }
  // Курбан айт — воскресенье 16.05, понедельник 17.05 не переносится
  const kurban = r27.find((r) => /Курбан/.test(r.note));
  assert.equal(kurban?.date, '2027-05-16');
  assert.equal(r27.some((r) => r.date === '2027-05-17'), false);
  // День Конституции — 15 марта; 30 августа больше не праздник
  assert.ok(r27.some((r) => r.date === '2027-03-15'));
  assert.equal(r27.some((r) => r.date === '2027-08-30'), false);
});

test('2027: рабочих дней — 251 без переносов (261 будний день минус 10 праздников) или 247 с четырьмя переносами по ст. 85', () => {
  const cal = createWorkCalendar(kzSettings());
  let n = 0;
  for (let d = '2027-01-01'; d <= '2027-12-31'; d = addLocalDays(d, 1)) if (cal.isWorkday(d)) n++;
  const hasTransfers = inYear(2027).some((r) => r.note.startsWith('Перенос с'));
  assert.equal(n, hasTransfers ? 247 : 251);
  assert.deepEqual(expectedArt85Transfers(2027), ['2027-01-04', '2027-03-24', '2027-05-03', '2027-05-10']);
});

test('CALENDAR.md перечисляет ожидаемые переносы 2027 и источники', () => {
  const md = read('presets/kz/CALENDAR.md');
  for (const s of ['04.01', '24.03', '03.05', '10.05', 'Минтруд', 'ДУМК', 'ст. 85', '26.10']) assert.ok(md.includes(s), `в CALENDAR.md нет «${s}»`);
});
