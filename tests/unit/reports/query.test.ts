// Разбор параметров отчёта: Zod .strict(), значения по умолчанию, фильтр сотрудников.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../../src/server/access';
import { parseReportQuery } from '../../../src/server/domain/reports/query';

const def = { from: '2026-10-26', to: '2026-10-28' };

test('по умолчанию: текущая неделя, без фильтров', () => {
  const q = parseReportQuery('operators', {}, def);
  assert.deepEqual(q, { key: 'operators', period: def, filters: { userIds: null, sourceKey: null }, grouping: 'total' });
  assert.equal(parseReportQuery('funnel', {}, def).key, 'funnel');
});

test('параметры: период, сотрудники (без повторов), источник, группировка и разрез', () => {
  const q = parseReportQuery('operators', { from: '2026-10-01', to: '2026-10-07', users: 'u1, u2,u1', source: 'new_base', group: 'week' }, def);
  assert.deepEqual(q.period, { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(q.filters, { userIds: ['u1', 'u2'], sourceKey: 'new_base' });
  assert.equal(q.key === 'operators' && q.grouping, 'week');
  const f = parseReportQuery('funnel', { by: 'source' }, def);
  assert.equal(f.key === 'funnel' && f.by, 'source');
  const a = parseReportQuery('attendance', { by: 'consultant' }, def);
  assert.equal(a.key === 'attendance' && a.by, 'consultant');
});

test('лишние ключи и неверные значения — ошибка', () => {
  assert.throws(() => parseReportQuery('revenue', { group: 'day' }, def), (e: unknown) => (e as { name?: string }).name === 'ZodError');
  assert.throws(() => parseReportQuery('operators', { group: 'month' }, def), (e: unknown) => (e as { name?: string }).name === 'ZodError');
  assert.throws(() => parseReportQuery('operators', { from: '28.10.2026' }, def), (e: unknown) => (e as { name?: string }).name === 'ZodError');
});

test('сотрудников не больше 50', () => {
  const ok = Array.from({ length: 50 }, (_, i) => `u${i}`).join(',');
  assert.equal(parseReportQuery('operators', { users: ok }, def).filters.userIds?.length, 50);
  const many = Array.from({ length: 51 }, (_, i) => `u${i}`).join(',');
  assert.throws(() => parseReportQuery('operators', { users: many }, def), (e: unknown) => e instanceof BadRequestError);
});

test('пустые значения считаются отсутствующими', () => {
  const q = parseReportQuery('operators', { users: '', source: '' }, def);
  assert.deepEqual(q.filters, { userIds: null, sourceKey: null });
});
