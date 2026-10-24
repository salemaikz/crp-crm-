// Отчёт «Причины»: блоки по колонкам доски ролей «мусор» и «перезвон», доли от итога блока (A4). Только синтетика.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReasonsReport, reasonColumns } from '../../../src/server/domain/reports/reasons';
import type { ResolvedPeriod } from '../../../src/server/domain/reports/reportTypes';

const period: ResolvedPeriod = { from: '2026-10-26', to: '2026-11-01', fromMs: 0, toMs: 1, timeZone: 'Asia/Almaty', days: 7 };
const columns = reasonColumns([
  { key: 'new', label: 'Новые', states: ['new'] },
  { key: 'callback', label: 'Перезвон', states: ['retry', 'callback'] },
  { key: 'br', label: 'Разбор', states: ['agreed'] },
  { key: 'purchase', label: 'Покупка', states: ['client'] },
  { key: 'trash', label: 'Мусор', states: ['not_interested', 'not_target', 'do_not_call', 'written_off'] },
]);

test('reasonColumns: остаются колонки ролей «мусор» и «перезвон» с подписью из пресета', () => {
  assert.deepEqual(columns.map((c) => [c.key, c.role, c.label]), [['callback', 'callback', 'Перезвон'], ['trash', 'trash', 'Мусор']]);
});

test('три причины «Мусора» из разных групп дают доли от одного итога блока', () => {
  const r = buildReasonsReport(
    period,
    [
      { grp: 'not_interested', reasonCode: 'no_need', n: 5 },
      { grp: 'not_target', reasonCode: 'company_closed', n: 3 },
      { grp: 'written_off', reasonCode: 'unreachable', n: 2 },
      { grp: 'callback', reasonCode: 'think', n: 1 },
      { grp: 'deal_lost', reasonCode: 'price', n: 4 },
    ],
    columns,
  );
  const trash = r.blocks.find((b) => b.key === 'trash')!;
  assert.equal(trash.total, 10);
  assert.deepEqual(trash.rows.map((x) => [x.group, x.reasonCode, x.count, x.share]), [
    ['not_interested', 'no_need', 5, 50],
    ['not_target', 'company_closed', 3, 30],
    ['written_off', 'unreachable', 2, 20],
  ]);
  const cb = r.blocks.find((b) => b.key === 'callback')!;
  assert.equal(cb.total, 1);
  assert.equal(cb.rows[0]!.share, 100);
  // прежние группы никуда не делись («Подробно»): доля внутри своей группы
  assert.equal(r.rows.find((x) => x.group === 'not_interested')!.share, 100);
  assert.ok(r.rows.some((x) => x.group === 'deal_lost'));
});

test('блок без причин за период остаётся пустым; без колонок блоков нет', () => {
  assert.equal(buildReasonsReport(period, [], columns).blocks.find((b) => b.key === 'trash')!.total, 0);
  assert.deepEqual(buildReasonsReport(period, [{ grp: 'callback', reasonCode: '', n: 2 }]).blocks, []);
});

test('одна причина в двух группах блока не склеивается: доля считается по строкам', () => {
  const r = buildReasonsReport(period, [{ grp: 'not_interested', reasonCode: 'x', n: 1 }, { grp: 'not_target', reasonCode: 'x', n: 1 }], columns);
  assert.deepEqual(r.blocks.find((b) => b.key === 'trash')!.rows.map((x) => x.share), [50, 50]);
});
