// Таблицы выгрузки отчётов (R3b §2.3): колонки каждого отчёта, подписи из локали и настроек, строка «Итого»; опасные
// строки в CSV и XLSX обезврежены; журнал — только белый список ключей без значений. Только синтетика.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from 'next-intl';
import reportsMessages from '../../../messages/ru/reports.json';
import { exportMeta } from '../../../src/server/domain/reports/exportLog';
import { exportTranslator, labelKey, toExportTable } from '../../../src/server/domain/reports/exportTable';
import { consumeTicket, issueTicket, resetTicketsForTests, TICKET_TTL_MS, TICKETS_MAX, ticketCount } from '../../../src/server/domain/reports/tickets';
import type { AttendanceReport, FunnelReport, OperatorsReport, ReasonsReport, ResolvedPeriod, RevenueReport } from '../../../src/server/domain/reports/reportTypes';
import { toExcelCsv } from '../../../src/server/platform/files';

type T = (key: string, values?: Record<string, string | number>) => string;
const tr = createTranslator({ locale: 'ru', messages: { reports: reportsMessages } as never, namespace: 'reports' as never }) as unknown as T;
const labels = {
  sources: { new_base: 'Новая база' },
  serviceTypes: { audit: 'Аудит' },
  eventTypes: { seminar: 'Семинар' },
  reasons: { not_interested: { expensive: 'Дорого' } },
};
const t = exportTranslator(tr, labels);
const period: ResolvedPeriod = { from: '2026-10-12', to: '2026-10-14', fromMs: 0, toMs: 1, timeZone: 'Asia/Almaty', days: 3 };

const metrics = {
  issued: 5, outcomes: 20, connects: 8, lpr: 2, groups: 1, consults: 1, attended: 1, noShow: 0, attendanceRate: 100,
  purchases: 1, purchaseSumKzt: 150_000, skips: 0, workedHours: 2, callsPerHour: 10,
};

test('операторы: колонки по локали, корзина при группировке, «ниже нормы», итог', () => {
  const r: OperatorsReport = {
    period,
    grouping: 'day',
    callsPerHourTarget: 12,
    rows: [{ ...metrics, userId: 'u1', name: '=Оператор', bucket: '2026-10-12', belowTarget: true }],
    totals: metrics,
  };
  const x = toExportTable('operators', r, t);
  assert.deepEqual(x.columns.slice(0, 3).map((c) => [c.key, c.label, c.type]), [
    ['name', 'Оператор', 'text'],
    ['bucket', 'Период', 'day'],
    ['issued', 'Выдано', 'int'],
  ]);
  assert.equal(x.columns.find((c) => c.key === 'purchaseSumKzt')?.type, 'money');
  assert.equal(x.columns.at(-1)?.label, 'Ниже нормы');
  assert.deepEqual(x.rows[0]?.slice(0, 3), ['=Оператор', '2026-10-12', 5]);
  assert.equal(x.rows[0]?.at(-1), 'да');
  assert.equal(x.rows[1]?.[0], 'Итого');
  assert.equal(x.rows.every((row) => row.length === x.columns.length), true);
  // без группировки колонки периода нет
  assert.equal(toExportTable('operators', { ...r, grouping: 'total' }, t).columns.some((c) => c.key === 'bucket'), false);
});

test('воронка, выручка, явка, причины: подписи из настроек и запасные подписи', () => {
  const rates = { issued: null, connected: 50, lpr: 25, booked: 10, attended: null, purchased: null };
  const counts = { issued: 10, connected: 5, lpr: 2, booked: 1, attended: 0, purchased: 0 };
  const f: FunnelReport = { period, by: 'source', rows: [{ key: 'new_base', name: null, counts, rates }, { key: '', name: null, counts, rates }], total: { key: '', name: null, counts, rates } };
  const ft = toExportTable('funnel', f, t);
  assert.deepEqual(ft.rows.map((r) => r[0]), ['Новая база', 'Источник не указан', 'Итого']);
  assert.equal(ft.columns.length, 1 + 6 + 5);
  assert.equal(ft.columns[3]?.label, 'Дозвонов, %');

  const rv: RevenueReport = {
    period,
    rows: [{ serviceTypeKey: 'audit', purchases: 1, sumKzt: 100, firstPurchases: 1, firstSumKzt: 100, repeatPurchases: 0, repeatSumKzt: 0 }, { serviceTypeKey: '', purchases: 1, sumKzt: 5, firstPurchases: 0, firstSumKzt: 0, repeatPurchases: 1, repeatSumKzt: 5 }],
    total: { purchases: 2, sumKzt: 105, firstPurchases: 1, firstSumKzt: 100, repeatPurchases: 1, repeatSumKzt: 5 },
  };
  assert.deepEqual(toExportTable('revenue', rv, t).rows.map((r) => [r[0], r[2]]), [['Аудит', 100], ['Тип не указан', 5], ['Итого', 105]]);

  const att = (key: string, name: string | null) => ({ key, name, booked: 1, attended: 1, noShow: 0, unmarked: 0, cancelled: 0, rate: 100, purchases: 0 });
  const total = { booked: 2, attended: 2, noShow: 0, unmarked: 0, cancelled: 0, rate: 100, purchases: 0 };
  const a1: AttendanceReport = { period, by: 'consultant', rows: [att('', null), att('u1', 'Консультант')], total };
  assert.deepEqual(toExportTable('attendance', a1, t).rows.map((r) => r[0]), ['Без консультанта', 'Консультант', 'Итого']);
  const a2: AttendanceReport = { period, by: 'event_type', rows: [att('seminar', null), att('unknown_type', null)], total };
  assert.deepEqual(toExportTable('attendance', a2, t).rows.map((r) => r[0]), ['Семинар', 'unknown_type', 'Итого']);

  const rs: ReasonsReport = {
    period,
    rows: [
      { group: 'not_interested', reasonCode: 'expensive', count: 3, share: 75 },
      { group: 'not_interested', reasonCode: '', count: 1, share: 25 },
    ],
  };
  assert.deepEqual(toExportTable('reasons', rs, t).rows, [
    ['Не интересно', 'Дорого', 3, 75],
    ['Не интересно', 'Причина не указана', 1, 25],
  ]);
  assert.equal(labelKey('reasons', 'g/c'), '@reasons:g/c');
});

test('опасные строки в выгрузке CSV обезврежены: =SUM, +7 709…, -5, @x', () => {
  const r: OperatorsReport = {
    period,
    grouping: 'total',
    callsPerHourTarget: null,
    rows: ['=SUM(A1)', '+7 709 100 00 01', '-5', '@x'].map((name, i) => ({ ...metrics, userId: `u${i}`, name, bucket: 'total', belowTarget: false })),
    totals: metrics,
  };
  const x = toExportTable('operators', r, t);
  const csv = toExcelCsv([x.columns.map((c) => c.label), ...x.rows]);
  for (const s of ["'=SUM(A1)", "'+7 709 100 00 01", "'-5", "'@x"]) assert.ok(csv.includes(`\r\n${s};`), s);
});

test('журнал: в meta только белый список, фильтры — именами, лишнее отброшено', () => {
  const meta = exportMeta({
    kind: 'report',
    reportKey: 'operators',
    format: 'csv',
    rows: 12,
    filterKeys: ['users', 'source', 'users', '77091000001', 'phone'],
    periodDays: 3,
    // поле не из типа: в журнал не попадает
    ...({ query: '+7 709 100 00 01' } as object),
  } as Parameters<typeof exportMeta>[0]);
  assert.deepEqual(Object.keys(meta).sort(), ['filterKeys', 'format', 'kind', 'periodDays', 'reportKey', 'rows']);
  assert.deepEqual(meta.filterKeys, ['source', 'users']);
  assert.ok(!/\d{5,}/.test(JSON.stringify(meta)));
  assert.equal(exportMeta({ kind: 'full', reportKey: null, format: 'zip', rows: -1, filterKeys: [], periodDays: null }).rows, 0);
});

test('билеты: одноразовые, 60 с, только свои; хранится не сам билет', () => {
  resetTicketsForTests();
  const now = 1_000_000;
  const a = issueTicket('u-a', now);
  assert.match(a.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.expiresAt, now + TICKET_TTL_MS);
  assert.equal(consumeTicket(a.ticket, 'u-a', now + 1), true);
  assert.equal(consumeTicket(a.ticket, 'u-a', now + 2), false, 'второй раз билет не работает');
  const b = issueTicket('u-b', now);
  assert.equal(consumeTicket(b.ticket, 'u-a', now), false, 'чужой билет');
  assert.equal(consumeTicket(b.ticket, 'u-b', now), false, 'чужая попытка гасит билет');
  const c = issueTicket('u-a', now);
  assert.equal(consumeTicket(c.ticket, 'u-a', now + TICKET_TTL_MS), false, 'просрочен');
  assert.equal(consumeTicket('not a ticket', 'u-a', now), false);
  for (let i = 0; i < TICKETS_MAX + 20; i++) issueTicket(`u${i}`, now);
  assert.ok(ticketCount() <= TICKETS_MAX);
  resetTicketsForTests();
});

test('CSV для русского Excel: доли с запятой (12.5, 33.3), целые и деньги не портятся', () => {
  const r: OperatorsReport = {
    period,
    grouping: 'total',
    callsPerHourTarget: null,
    rows: [{ ...metrics, userId: 'u1', name: 'Иван', bucket: 'total', belowTarget: false, attendanceRate: 12.5, callsPerHour: 33.3, purchaseSumKzt: 1_500_000 }],
    totals: metrics,
  };
  const x = toExportTable('operators', r, t);
  const csv = toExcelCsv([x.columns.map((c) => c.label), ...x.rows]);
  assert.ok(csv.includes(';12,5;'), '12,5');
  assert.ok(csv.includes('33,3'), '33,3');
  assert.ok(csv.includes(';1500000;'), 'деньги целым');
  assert.ok(!/\d\.\d/.test(csv), 'точки в числах нет');
});
