// Реестр задач: имена уникальны, расписания допустимы на тестовом календаре, perSpace раскладывается по пространствам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import type { ActiveConfig } from '@crm/core/config';
import { instancesFor, jobDefinitions, queueSpecs } from '../../../src/server/jobs/registry';
import { slotFor } from '../../../src/server/platform/jobs/slot';
import type { JobDefinition } from '../../../src/server/platform/jobs/types';

const cfg = { global: { doc: {} }, spaces: { sales: { spaceId: 's1', doc: {} }, ops: { spaceId: 's2', doc: {} } } } as unknown as ActiveConfig;
const cal = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});

test('имена задач уникальны и допустимы', () => {
  const names = jobDefinitions().map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[a-z][a-z0-9-]*$/);
});

test('расписание каждой задачи даёт слот или null на любой момент суток, без исключений', () => {
  for (const inst of instancesFor(jobDefinitions(), cfg)) {
    assert.ok(inst.spec === null || typeof inst.spec.kind === 'string');
    if (!inst.spec) continue;
    for (let t = Date.parse('2026-10-27T00:00:00Z'); t < Date.parse('2026-10-29T00:00:00Z'); t += 11 * 60_000) {
      assert.doesNotThrow(() => slotFor(inst.spec!, t, cal));
    }
  }
});

test('perSpace раскладывается по пространствам, остальные — один экземпляр', () => {
  const per: JobDefinition = { name: 'demo', perSpace: true, schedule: () => ({ kind: 'interval', everyMin: 5 }), writes: 'business', handler: async () => ({ status: 'ok', stats: {} }) };
  const out = instancesFor([per, ...jobDefinitions().slice(0, 1)], cfg);
  assert.deepEqual(out.map((i) => i.runName), ['demo@sales', 'demo@ops', jobDefinitions()[0]!.name]);
  assert.deepEqual(out[0]!.space, { id: 's1', key: 'sales' });
});

test('в реестре есть events-ensure, purge, invariants; license — заглушка с запуском при старте', () => {
  const byName = new Map(jobDefinitions().map((d) => [d.name, d]));
  for (const n of ['events-ensure', 'purge', 'invariants', 'license', 'config-integrity']) assert.ok(byName.has(n), n);
  assert.equal(byName.get('license')!.runOnStart, true);
  assert.equal(byName.get('events-ensure')!.schedule({ global: {}, space: null })!.kind, 'daily');
  assert.deepEqual(queueSpecs().map((q) => q.name), ['webhook_inbox', 'push_outbox']);
});
