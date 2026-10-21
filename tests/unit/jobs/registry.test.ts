// Реестр задач: имена уникальны, расписания допустимы на тестовом календаре, perSpace раскладывается по пространствам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import type { ActiveConfig } from '@crm/core/config';
import { systemActor } from '../../../src/server/access/systemActor';
import { instancesFor, invariantParts, jobDefinitions, purgeParts, queueSpecs } from '../../../src/server/jobs/registry';
import { licenseJobHandler } from '../../../src/server/platform/license/job';
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

test('в реестре есть events-ensure, purge, invariants, digest, alarms; license — настоящий обработчик с запуском при старте', () => {
  const byName = new Map(jobDefinitions().map((d) => [d.name, d]));
  for (const n of ['events-ensure', 'distribute', 'purge', 'invariants', 'license', 'config-integrity', 'digest', 'alarms']) assert.ok(byName.has(n), n);
  assert.equal(byName.get('license')!.handler, licenseJobHandler);
  assert.equal(byName.get('digest')!.perSpace, true);
  assert.equal(byName.get('alarms')!.perSpace, true);
  assert.equal(byName.get('license')!.runOnStart, true);
  assert.equal(byName.get('events-ensure')!.schedule({ global: {}, space: null })!.kind, 'daily');
  assert.deepEqual(queueSpecs().map((q) => q.name), ['webhook_inbox', 'push_outbox']);
});

test('distribute и absence — по пространствам; части invariants и purge подключены', () => {
  const byName = new Map(jobDefinitions().map((d) => [d.name, d]));
  assert.equal(byName.get('distribute')!.perSpace, true);
  // «Отсутствует» (D-255): без задачи будущие отсутствия не применяются, а временные не снимаются по сроку
  assert.equal(byName.get('absence')?.perSpace, true);
  assert.deepEqual(byName.get('absence')!.schedule({ global: {}, space: {} }), { kind: 'daily', at: '07:30', days: 'all' });
  assert.deepEqual(invariantParts.map((p) => p.key), ['ownerless_cards']);
  assert.deepEqual(purgeParts.map((p) => p.key), ['sessions', 'invites', 'push_outbox', 'device_status', 'import_rows', 'change_snapshots']);
});

test('имя экземпляра `distribute@sales` принимает systemActor (аудит пишет имя как есть)', () => {
  assert.equal(systemActor('distribute@sales', 1).job, 'distribute@sales');
  assert.throws(() => systemActor('Distribute@Sales'), /имя задачи/);
  assert.throws(() => systemActor('a b'), /имя задачи/);
});
