// runInstance с поддельными зависимостями: блокировка, слот, таймаут, лицензия, ошибки без текста.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import type { SystemActor } from '../../../src/server/access';
import { runInstance, errorCode, type RunnerDeps } from '../../../src/server/platform/jobs/runner';
import type { ClaimResult, JobDefinition, JobInstance } from '../../../src/server/platform/jobs/types';

const calendar = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});
const NOW = Date.parse('2026-10-28T06:00:00Z');

interface Fake {
  deps: RunnerDeps;
  finished: { runId: string; status: string; error: string; stats: unknown }[];
  released: number;
  exits: number[];
}

function fake(over: { locked?: boolean; claim?: ClaimResult; blocked?: boolean; grace?: number } = {}): Fake {
  const f: Fake = { deps: null as never, finished: [], released: 0, exits: [] };
  f.deps = {
    lock: async () => (over.locked ? null : { release: async () => void f.released++ }),
    claim: async () => over.claim ?? { kind: 'claimed', runId: 'run-1', attempt: 1 },
    finish: async (runId, status, stats, error) => void f.finished.push({ runId, status, stats, error }),
    businessBlocked: async () => over.blocked ?? false,
    actorFor: (job, now) => ({ kind: 'system', job, now }) as SystemActor,
    log: { info() {}, warn() {} },
    clock: () => NOW,
    exit: (c) => void f.exits.push(c),
    hardKillGraceMs: over.grace ?? 10,
  };
  return f;
}

function inst(over: Partial<JobDefinition> = {}): JobInstance {
  const def: JobDefinition = {
    name: 'demo',
    perSpace: false,
    schedule: () => ({ kind: 'interval', everyMin: 5 }),
    writes: 'business',
    handler: async () => ({ status: 'ok', stats: { n: 1 } }),
    ...over,
  };
  return { def, runName: 'demo', space: null, spec: { kind: 'interval', everyMin: 5 } };
}

test('успех: итог записан, блокировка снята', async () => {
  const f = fake();
  const out = await runInstance(f.deps, inst(), { now: NOW, calendar });
  assert.deepEqual(out, { kind: 'ran', status: 'ok', runId: 'run-1', attempt: 1, error: '' });
  assert.deepEqual(f.finished[0], { runId: 'run-1', status: 'ok', stats: { n: 1 }, error: '' });
  assert.equal(f.released, 1);
});

test('нет слота и manual: обработчик не вызывается', async () => {
  const f = fake();
  let called = 0;
  const i = inst({ handler: async () => (called++, { status: 'ok', stats: {} }) });
  assert.deepEqual(await runInstance(f.deps, { ...i, spec: { kind: 'manual' } }, { now: NOW, calendar }), { kind: 'no_slot' });
  assert.deepEqual(await runInstance(f.deps, { ...i, spec: null }, { now: NOW, calendar }), { kind: 'no_slot' });
  assert.equal(called, 0);
});

test('блокировка занята: ничего не пишем', async () => {
  const f = fake({ locked: true });
  assert.deepEqual(await runInstance(f.deps, inst(), { now: NOW, calendar }), { kind: 'locked' });
  assert.equal(f.finished.length, 0);
});

test('слот закрыт или ждёт паузы: обработчик не вызывается', async () => {
  for (const claim of [{ kind: 'done' }, { kind: 'backoff', retryAt: NOW + 1 }] as ClaimResult[]) {
    const f = fake({ claim });
    let called = 0;
    const out = await runInstance(f.deps, inst({ handler: async () => (called++, { status: 'ok', stats: {} }) }), { now: NOW, calendar });
    assert.equal(out.kind, 'not_claimed');
    assert.equal(called, 0);
    assert.equal(f.released, 1);
  }
});

test('ошибка: failed с кодом, без текста исключения', async () => {
  const f = fake();
  const i = inst({
    handler: async () => {
      throw Object.assign(new Error('+7 709 000 00 00 секрет'), { code: 'db_down' });
    },
  });
  const out = await runInstance(f.deps, i, { now: NOW, calendar });
  assert.equal(out.kind === 'ran' && out.status, 'failed');
  assert.equal(f.finished[0]?.error, 'db_down');
  assert.equal(errorCode(new TypeError('x y z')), 'TypeError');
});

test('таймаут: signal сработал, failed timeout', async () => {
  const f = fake();
  let aborted = false;
  const i = inst({
    timeoutMs: 20,
    handler: (ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ status: 'ok', stats: {} });
        });
      }),
  });
  const out = await runInstance(f.deps, i, { now: NOW, calendar });
  assert.equal(out.kind === 'ran' && out.error, 'timeout');
  assert.equal(f.finished[0]?.status, 'failed');
  assert.ok(aborted);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(f.exits, [], 'вернувшийся обработчик отменяет принудительный выход');
});

test('зависший обработчик: после паузы процесс завершается кодом 70', async () => {
  const f = fake({ grace: 10 });
  const i = inst({ timeoutMs: 10, handler: () => new Promise(() => {}) });
  await runInstance(f.deps, i, { now: NOW, calendar });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(f.exits, [70]);
});

test('лицензия read_only: business пропускается, housekeeping работает', async () => {
  const f = fake({ blocked: true });
  let called = 0;
  const h = async () => (called++, { status: 'ok' as const, stats: {} });
  const a = await runInstance(f.deps, inst({ handler: h }), { now: NOW, calendar });
  assert.equal(a.kind === 'ran' && a.status, 'skipped');
  assert.equal(f.finished[0]?.error, 'license_read_only');
  assert.equal(called, 0);
  await runInstance(f.deps, inst({ writes: 'housekeeping', handler: h }), { now: NOW, calendar });
  assert.equal(called, 1);
});

test('явный слот (ручной запуск) обходит расписание', async () => {
  const f = fake();
  const out = await runInstance(f.deps, { ...inst(), spec: { kind: 'manual' } }, { now: NOW, calendar, slot: { key: 'manual:x', at: NOW } });
  assert.equal(out.kind, 'ran');
});
