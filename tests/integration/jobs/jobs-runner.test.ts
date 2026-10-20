// Прогон задач на Postgres 16: слоты, блокировки, повторы, сироты, пульс (worker-design §8).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import { makeRunnerDeps } from '../../../src/server/jobs/deps';
import { tryAdvisoryLock } from '../../../src/server/platform/db/locks';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { createTestDb } from '../../../src/server/platform/db/testing';
import { beatHeartbeat, claim, runInstance, JOB_LOCK_CLASS, WORKER_HEARTBEAT_JOB } from '../../../src/server/platform/jobs';
import type { JobDefinition, JobInstance, RunnerDeps } from '../../../src/server/platform/jobs';

let db: TestDb;
const calendar = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});
const T0 = Date.parse('2026-10-28T06:00:00Z');
const clock = { now: T0 };

function deps(): RunnerDeps {
  return { ...makeRunnerDeps({ info() {}, warn() {} }), clock: () => clock.now };
}

function inst(name: string, handler: JobDefinition['handler'], over: Partial<JobDefinition> = {}): JobInstance {
  const def: JobDefinition = { name, perSpace: false, schedule: () => ({ kind: 'interval', everyMin: 5 }), writes: 'housekeeping', handler, ...over };
  return { def, runName: name, space: null, spec: { kind: 'interval', everyMin: 5 } };
}

const rows = (job: string) => db.sql<{ status: string; attempt: number; error: string; slotKey: string; id: string }>`SELECT id, status, attempt, error, slot_key FROM job_runs WHERE job = ${job} ORDER BY started_at, slot_key`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

test('двойной запуск: две копии воркера — обработчик один раз, одна строка job_runs', async () => {
  let calls = 0;
  const i = inst('twice', async () => (calls++, await sleep(150), { status: 'ok', stats: { n: 1 } }));
  const out = await Promise.all([runInstance(deps(), i, { now: clock.now, calendar }), runInstance(deps(), i, { now: clock.now, calendar })]);
  assert.equal(calls, 1);
  assert.deepEqual(out.map((o) => o.kind).sort(), ['locked', 'ran']);
  assert.equal((await rows('twice')).length, 1);
});

test('тот же слот после ok не повторяется, новый слот — запускается', async () => {
  let calls = 0;
  const i = inst('slots', async () => (calls++, { status: 'ok', stats: {} }));
  await runInstance(deps(), i, { now: clock.now, calendar });
  const again = await runInstance(deps(), i, { now: clock.now + 60_000, calendar });
  assert.deepEqual(again, { kind: 'not_claimed', reason: 'done' });
  await runInstance(deps(), i, { now: clock.now + 6 * 60_000, calendar });
  assert.equal(calls, 2);
  assert.equal((await rows('slots')).length, 2);
});

test('упал: пауза, повтор с тем же runId, после maxAttempts больше нет', async () => {
  let calls = 0;
  const i = inst('flaky', async () => {
    calls++;
    throw Object.assign(new Error('x'), { code: 'boom' });
  });
  clock.now = T0;
  const a1 = await runInstance(deps(), i, { now: clock.now, calendar });
  assert.equal(a1.kind === 'ran' && a1.attempt, 1);
  clock.now = T0 + 10_000; // слот тот же (5 минут), пауза не прошла
  const early = await runInstance(deps(), i, { now: clock.now, calendar });
  assert.equal(early.kind, 'not_claimed');
  assert.equal(calls, 1);
  clock.now = T0 + 61_000;
  const a2 = await runInstance(deps(), i, { now: clock.now, calendar });
  assert.ok(a1.kind === 'ran' && a2.kind === 'ran' && a2.attempt === 2 && a2.runId === a1.runId);
  clock.now = T0 + 61_000 + 121_000; // всё ещё в слоте T0+5 мин? нет — слот тот же до 5-й минуты
  const slotStillSame = clock.now < T0 + 5 * 60_000;
  assert.ok(slotStillSame);
  const a3 = await runInstance(deps(), i, { now: clock.now, calendar });
  assert.equal(a3.kind === 'ran' && a3.attempt, 3);
  clock.now = T0 + 4 * 60_000 + 59_000;
  const a4 = await runInstance(deps(), i, { now: clock.now, calendar });
  assert.equal(a4.kind, 'not_claimed');
  assert.equal(calls, 3);
  const [row] = await rows('flaky');
  assert.deepEqual({ status: row!.status, attempt: row!.attempt, error: row!.error }, { status: 'failed', attempt: 3, error: 'boom' });
  clock.now = T0;
});

test('сирота: running без блокировки становится failed orphaned и повторяется после паузы', async () => {
  await db.sql`INSERT INTO job_runs (id, job, slot_key, status, attempt, started_at) VALUES ('orph-1', 'orphan', '2026-10-28T11:00', 'running', 1, ${T0 - 600_000})`;
  const first = await claim(db, 'orphan', '2026-10-28T11:00', T0, 3);
  assert.equal(first.kind, 'backoff');
  const [r1] = await rows('orphan');
  assert.deepEqual({ status: r1!.status, error: r1!.error }, { status: 'failed', error: 'orphaned' });
  const second = await claim(db, 'orphan', '2026-10-28T11:00', T0 + 61_000, 3);
  assert.deepEqual(second, { kind: 'claimed', runId: 'orph-1', attempt: 2 });
});

test('блокировку держит другое соединение: прогон пропущен без записи', async () => {
  const held = await tryAdvisoryLock(db, JOB_LOCK_CLASS, 'held');
  assert.ok(held);
  let calls = 0;
  const out = await runInstance(deps(), inst('held', async () => (calls++, { status: 'ok', stats: {} })), { now: clock.now, calendar });
  assert.deepEqual(out, { kind: 'locked' });
  assert.equal(calls, 0);
  assert.equal((await rows('held')).length, 0);
  await held.release();
  const after = await runInstance(deps(), inst('held', async () => (calls++, { status: 'ok', stats: {} })), { now: clock.now, calendar });
  assert.equal(after.kind, 'ran');
});

test('убитый процесс: соединение закрыто — блокировка снята', async () => {
  const held = await tryAdvisoryLock(db, JOB_LOCK_CLASS, 'killed');
  assert.ok(held);
  assert.equal(await tryAdvisoryLock(db, JOB_LOCK_CLASS, 'killed'), null);
  const pids = await db.sql<{ pid: number }>`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = ${JOB_LOCK_CLASS} AND granted`;
  assert.equal(pids.length, 1);
  await db.sql`SELECT pg_terminate_backend(${pids[0]!.pid})`;
  let again = null;
  for (let k = 0; k < 20 && !again; k++) {
    await sleep(50);
    again = await tryAdvisoryLock(db, JOB_LOCK_CLASS, 'killed');
  }
  assert.ok(again, 'блокировка должна сняться');
  await again.release();
});

test('пульс: три цикла — одна строка, finished_at растёт', async () => {
  const seen: number[] = [];
  for (let k = 1; k <= 3; k++) {
    await beatHeartbeat(db, { startedAt: T0, lastLoopAt: T0 + k * 30_000, jobs: 5 }, T0 + k * 30_000);
    const r = await db.sql<{ finishedAt: number }>`SELECT finished_at FROM job_runs WHERE job = ${WORKER_HEARTBEAT_JOB}`;
    assert.equal(r.length, 1);
    seen.push(r[0]!.finishedAt);
  }
  assert.deepEqual(seen, [T0 + 30_000, T0 + 60_000, T0 + 90_000]);
});
