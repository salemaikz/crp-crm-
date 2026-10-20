// Цикл воркера целиком: расписание, запуск при старте, пульс, файл живости, остановка.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ActiveConfig } from '@crm/core/config';
import { createWorker } from '../../../src/server/jobs/worker';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { createTestDb } from '../../../src/server/platform/db/testing';
import type { JobDefinition } from '../../../src/server/platform/jobs';

let db: TestDb;
const cfg = {
  global: {
    doc: {
      org: { timezone: 'Asia/Almaty' },
      calendar: { workdays: [1, 2, 3, 4, 5], workHours: { start: '09:00', end: '18:00' }, callWindow: { start: '09:00', end: '18:00' }, holidays: [] },
    },
  },
  spaces: { sales: { spaceId: 's1', doc: {} } },
} as unknown as ActiveConfig;
const log = { info() {}, warn() {} };

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

test('цикл: задача по пространствам и запуск при старте один раз, пульс одной строкой, файл живости', async () => {
  const calls: string[] = [];
  const mk = (name: string, over: Partial<JobDefinition>): JobDefinition => ({
    name,
    perSpace: false,
    schedule: () => ({ kind: 'interval', everyMin: 5 }),
    writes: 'housekeeping',
    handler: async (ctx) => (calls.push(`${name}:${ctx.slot.key.startsWith('boot:') ? 'boot' : 'slot'}:${ctx.space?.key ?? '-'}`), { status: 'ok', stats: {} }),
    ...over,
  });
  const alive = path.join(mkdtempSync(path.join(tmpdir(), 'crm-w-')), 'alive');
  const w = createWorker({
    defs: () => [mk('per', { perSpace: true }), mk('lic', { runOnStart: true, schedule: () => null })],
    queues: () => [],
    loadConfig: async () => cfg,
    log,
    aliveFile: alive,
  });
  await w.runCycle();
  await w.runCycle();
  await w.runCycle();
  assert.deepEqual(calls, ['per:slot:sales', 'lic:boot:-']);
  const hb = await db.sql<{ stats: { jobs: number } }>`SELECT stats FROM job_runs WHERE job = 'worker.heartbeat'`;
  assert.equal(hb.length, 1);
  assert.equal(hb[0]!.stats.jobs, 2);
  assert.ok(Date.now() - statSync(alive).mtimeMs < 5000);
  await w.stop();
});

test('файл живости обновляется после каждого экземпляра задачи, а не только в конце цикла', async () => {
  const alive = path.join(mkdtempSync(path.join(tmpdir(), 'crm-w-')), 'alive');
  const seen: boolean[] = [];
  const mk = (name: string, handler: JobDefinition['handler']): JobDefinition => ({
    name,
    perSpace: false,
    schedule: () => ({ kind: 'interval', everyMin: 5 }),
    writes: 'housekeeping',
    handler,
  });
  const w = createWorker({
    defs: () => [mk('first', async () => ({ status: 'ok', stats: {} })), mk('second', async () => (seen.push(existsSync(alive)), { status: 'ok', stats: {} }))],
    queues: () => [],
    loadConfig: async () => cfg,
    log,
    aliveFile: alive,
  });
  await w.runCycle();
  assert.deepEqual(seen, [true], 'к началу второй задачи файл уже записан после первой');
  await w.stop();
});

test('нет настроек: цикл не падает, пульс пишется с нулём задач', async () => {
  const w = createWorker({ defs: () => [], queues: () => [], loadConfig: async () => null, log, aliveFile: null });
  await w.runCycle();
  const hb = await db.sql<{ stats: { jobs: number } }>`SELECT stats FROM job_runs WHERE job = 'worker.heartbeat'`;
  assert.equal(hb[0]!.stats.jobs, 0);
  await w.stop();
});
