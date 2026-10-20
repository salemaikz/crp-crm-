// Расписание задачи раздачи из настроек: сетка окна для автоматических режимов, null для manual и off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distributeJob, distributeSchedule } from '../../../src/server/domain/distribution/job';

const space = (mode: string, over: Record<string, unknown> = {}) => ({
  distribution: { mode, schedule: { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true }, ...over },
});

test('auto_even и top_up → сетка 08:00–18:00 каждый час по рабочим дням, догон 15 минут', () => {
  for (const mode of ['auto_even', 'top_up']) {
    assert.deepEqual(distributeSchedule({ global: {}, space: space(mode) }), {
      kind: 'grid',
      from: '08:00',
      to: '18:00',
      everyMin: 60,
      days: 'workdays',
      graceMin: 15,
    });
  }
});

test('workdaysOnly = false → все дни', () => {
  const spec = distributeSchedule({ global: {}, space: space('auto_even', { schedule: { from: '09:00', to: '12:00', everyMin: 30, workdaysOnly: false } }) });
  assert.deepEqual(spec, { kind: 'grid', from: '09:00', to: '12:00', everyMin: 30, days: 'all', graceMin: 15 });
});

test('manual и off → задачи нет', () => {
  assert.equal(distributeSchedule({ global: {}, space: space('manual') }), null);
  assert.equal(distributeSchedule({ global: {}, space: space('off') }), null);
});

test('нет документа пространства или он сломан → задачи нет', () => {
  assert.equal(distributeSchedule({ global: {}, space: null }), null);
  assert.equal(distributeSchedule({ global: {}, space: { distribution: { mode: 'x' } } }), null);
});

test('определение задачи: по пространству, пишущая бизнес-данные', () => {
  assert.equal(distributeJob.name, 'distribute');
  assert.equal(distributeJob.perSpace, true);
  assert.equal(distributeJob.writes, 'business');
});
