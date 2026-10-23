// Чистые части аналитики v2 (D-343, D-344): средняя по операторам, курсор списка явки, разбор параметров, причины.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meanRate, AVERAGE_MIN_CONNECTS } from '../../../src/server/domain/reports/definitions';
import { decodeListCursor, encodeListCursor } from '../../../src/server/domain/reports/attendance';
import { averageConversions, emptyCounts } from '../../../src/server/domain/reports/operators';
import { parseReportQuery } from '../../../src/server/domain/reports/query';
import { buildReasonsReport } from '../../../src/server/domain/reports/reasons';

const def = { from: '2026-10-05', to: '2026-10-11' };

test('meanRate: пустые доли пропускаются, нет долей — null, один знак', () => {
  assert.equal(meanRate([20, 40, null]), 30);
  assert.equal(meanRate([null]), null);
  assert.equal(meanRate([10, 11, 11]), 10.7);
});

test('averageConversions: порог дозвонов включительно, команда не смешивается', () => {
  const c = (connects: number, booked: number) => ({ ...emptyCounts(), connects, groups: booked });
  const avg = averageConversions([c(20, 4), c(19, 19), c(40, 20)]);
  assert.equal(AVERAGE_MIN_CONNECTS, 20);
  assert.equal(avg.operators, 2);
  assert.equal(avg.bookedPerConnect, 35); // (20 + 50) / 2
  assert.equal(averageConversions([c(5, 5)]).bookedPerConnect, null);
});

test('курсор списка: круг туда-обратно, чужая форма отвергается', () => {
  const cur = encodeListCursor('1789000000000', 'bk-1');
  assert.deepEqual(decodeListCursor(cur), { startsAt: 1789000000000, id: 'bk-1' });
  for (const bad of ["x'; --", '12', '.id', '12.', '1.a b']) assert.equal(decodeListCursor(bad), null, bad);
});

test('параметры явки: список с фильтрами; фильтры без view=list и плохой курсор — ошибка', () => {
  const q = parseReportQuery('attendance', { view: 'list', status: 'no_show', eventType: 'k', consultant: 'u1', limit: '10' }, def);
  assert.ok(q.key === 'attendance' && q.view === 'list');
  if (q.key === 'attendance' && q.view === 'list') assert.deepEqual(q.list, { eventType: 'k', status: 'no_show', consultant: 'u1', cursor: null, limit: 10 });
  assert.throws(() => parseReportQuery('attendance', { status: 'no_show' }, def));
  assert.throws(() => parseReportQuery('attendance', { view: 'list', cursor: 'bad cursor' }, def));
  assert.throws(() => parseReportQuery('attendance', { view: 'list', limit: '9999' }, def));
});

test('причины: порядок групп, доли внутри группы, неизвестная группа отброшена', () => {
  const period = { from: def.from, to: def.to, fromMs: 0, toMs: 1, timeZone: 'Asia/Almaty', days: 7 };
  const r = buildReasonsReport(period, [
    { grp: 'no_show', reasonCode: 'k', n: 1 },
    { grp: 'written_off', reasonCode: 'a', n: 3 },
    { grp: 'callback', reasonCode: '', n: 1 },
    { grp: 'callback', reasonCode: 'x', n: 3 },
    { grp: 'strange', reasonCode: 'q', n: 9 },
  ]);
  assert.deepEqual(r.rows.map((x) => [x.group, x.reasonCode, x.share]), [['callback', 'x', 75], ['callback', '', 25], ['written_off', 'a', 100], ['no_show', 'k', 100]]);
});
