/**
 * Недельный отчёт по записям и явке и его CSV.
 *
 * Отчёт сверяют с ручным подсчётом, и от него зависит бонус продавцу. Проверяем то, где подсчёт
 * легко сделать «правдоподобно неверным»: перенос, явка без неотмеченных, кому засчитана запись.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csvCell, toCsv } from './csv';
import { summarizeWeek, summaryForScreen, weeklySummaryCsv, type SummaryCsvLabels, type SummaryRow } from './summary';

function row(p: Partial<SummaryRow>): SummaryRow {
  return {
    id: Math.random().toString(36).slice(2), eventTypeKey: 'group_event', behavior: 'group', bookingDate: '2026-10-22', startTime: '15:00',
    status: 'registered', isReserve: false, eventId: 'ev1', eventTitle: 'Групповая встреча', eventCapacity: 30, consultantId: null,
    consultantName: null, bookedByUserId: 'u-a', bookedByName: 'Сотрудник А', clientName: 'Клиент', clientPhone: '+7 709 000 00 00',
    direction: '', ...p,
  };
}

const consult = (p: Partial<SummaryRow>) =>
  row({ eventTypeKey: 'consultation', behavior: 'individual', eventId: null, eventTitle: null, bookingDate: '2026-10-20', startTime: '11:00', ...p });

const ROWS: SummaryRow[] = [
  row({ status: 'attended' }),
  row({ status: 'attended' }),
  row({ status: 'no_show' }),
  row({ status: 'confirmed' }),
  row({ status: 'moved', bookedByUserId: 'u-b', bookedByName: 'Сотрудник Б' }),
  row({ status: 'cancelled', bookedByUserId: 'u-b', bookedByName: 'Сотрудник Б' }),
  consult({ consultantId: 'c-1', consultantName: 'Консультант 1', status: 'attended', bookedByUserId: 'u-b', bookedByName: 'Сотрудник Б' }),
  consult({ consultantId: 'c-1', consultantName: 'Консультант 1', status: 'registered', isReserve: true }),
  consult({ consultantId: null, consultantName: null, status: 'registered', bookingDate: '2026-10-21', startTime: '14:00' }),
];

test('по мероприятию: явка считается только по отмеченным', () => {
  const s = summarizeWeek(ROWS, '2026-10-19', '2026-10-25');
  assert.equal(s.byEvent.length, 1);
  const e = s.byEvent[0]!;
  assert.deepEqual([e.total, e.attended, e.noShow, e.confirmed, e.moved, e.cancelled], [6, 2, 1, 3, 1, 1]);
  // «Подтвердили» включает пришедших: 1 подтвердивший + 2 пришедших.
  // 2 из 3 отмеченных; подтвердивший, но не отмеченный, в знаменатель не входит.
  assert.equal(e.attendanceRate, 66.7);
});

test('по консультанту: резерв виден, «серые» — отдельной строкой без имени', () => {
  const s = summarizeWeek(ROWS, '2026-10-19', '2026-10-25');
  const c1 = s.byConsultant.find((c) => c.consultantId === 'c-1')!;
  assert.deepEqual([c1.total, c1.attended, c1.reserve], [2, 1, 1]);
  const grey = s.byConsultant.find((c) => c.consultantId === null)!;
  assert.equal(grey.total, 1);
  assert.equal(s.byConsultant[s.byConsultant.length - 1]?.consultantId, null, 'без имени — последней');
});

test('по сотруднику: запись засчитана тому, кто записал, с разбивкой по видам', () => {
  const s = summarizeWeek(ROWS, '2026-10-19', '2026-10-25');
  const a = s.byEmployee.find((p) => p.userId === 'u-a')!;
  const b = s.byEmployee.find((p) => p.userId === 'u-b')!;
  assert.deepEqual([a.byType['group_event'], a.byType['consultation'], a.attended, a.noShow], [4, 2, 2, 1]);
  assert.deepEqual([b.byType['group_event'], b.byType['consultation'], b.moved, b.cancelled, b.attended], [2, 1, 1, 1, 1]);
  assert.equal(s.byEmployee[0]?.userId, 'u-a', 'сверху — кто записал больше');
});

test('перенос: исходная — в «Перенос», новая запись считается у своей встречи', () => {
  const rows = [
    row({ id: 'old', status: 'moved', eventId: 'ev1' }),
    row({ id: 'new', status: 'registered', eventId: 'ev2', bookingDate: '2026-10-29' }),
  ];
  const s = summarizeWeek(rows, '2026-10-19', '2026-11-01');
  assert.deepEqual(s.byEvent.map((e) => [e.eventId, e.moved, e.registered]), [['ev1', 1, 0], ['ev2', 0, 1]]);
});

test('пустая неделя — нули и «явка неизвестна», а не 0 %', () => {
  const s = summarizeWeek([], '2026-10-19', '2026-10-25');
  assert.equal(s.totals.total, 0);
  assert.equal(s.totals.attendanceRate, null);
});

test('экранный отчёт не содержит телефонов: их охраняет право экспорта', () => {
  const screen = summaryForScreen(summarizeWeek(ROWS, '2026-10-19', '2026-10-25'));
  assert.equal(screen.rows.length, ROWS.length);
  for (const r of screen.rows) assert.equal('clientPhone' in r, false);
  assert.ok(!JSON.stringify(screen).includes('+7 709'));
});

const LABELS: SummaryCsvLabels = {
  status: { registered: 'Записан', confirmed: 'Подтвердил', attended: 'Пришёл', no_show: 'Не пришёл', cancelled: 'Отмена', moved: 'Перенос' },
  typeShort: { group_event: 'Гр', consultation: 'Конс' },
  csv: {
    sectionEvents: 'По мероприятиям', sectionConsultants: 'По консультантам', sectionEmployees: 'По сотрудникам', sectionBookings: 'Записи',
    date: 'Дата', time: 'Время', event: 'Мероприятие', capacity: 'Мест', total: 'Записано', confirmed: 'Подтвердили', attended: 'Пришли',
    noShow: 'Не пришли', cancelled: 'Отмены', moved: 'Переносы', attendanceRate: 'Явка, %', consultant: 'Консультант', reserve: 'Резерв',
    employee: 'Сотрудник', kind: 'Вид', target: 'Куда', client: 'Клиент', phone: 'Телефон', direction: 'Направление', bookedBy: 'Записал',
    status: 'Статус', unassigned: 'Не назначен', unknownEmployee: 'Не указан', yes: 'да',
  },
};

test('CSV: BOM, четыре блока, подписи из параметра, а не из кода', () => {
  const csv = weeklySummaryCsv(summarizeWeek(ROWS, '2026-10-19', '2026-10-25'), LABELS);
  assert.ok(csv.startsWith('﻿'), 'без BOM Excel покажет кракозябры');
  for (const block of ['По мероприятиям', 'По консультантам', 'По сотрудникам', 'Записи']) assert.ok(csv.includes(block), block);
  assert.ok(csv.includes('Не пришёл'));
  assert.ok(csv.includes('Не назначен'), '«серая» запись подписана, а не пуста');
  assert.ok(csv.includes('Сотрудник,Гр,Конс,'), 'колонки видов — в порядке подписей');
  const other = weeklySummaryCsv(summarizeWeek(ROWS, '2026-10-19', '2026-10-25'), { ...LABELS, status: { ...LABELS.status, no_show: 'Келмеді' } });
  assert.ok(other.includes('Келмеді'));
});

test('CSV: формула из имени клиента экранируется, телефон с плюсом — нет', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(csvCell('+7 (709) 000-00-00'), '+7 (709) 000-00-00');
  assert.equal(csvCell('-1+2'), `'-1+2`);
  assert.equal(csvCell('ТОО «Ромашка», филиал'), '"ТОО «Ромашка», филиал"');
  assert.equal(toCsv([['a', null, 3]]), '﻿a,,3');
});

test('CSV: имя клиента-формула в выгрузке записей экранировано', () => {
  const evil = [row({ clientName: '=1+1', status: 'attended' })];
  const csv = weeklySummaryCsv(summarizeWeek(evil, '2026-10-19', '2026-10-25'), LABELS);
  assert.ok(csv.includes(`'=1+1`));
  assert.ok(!csv.includes(',=1+1,'));
});
