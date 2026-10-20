// Тик раздачи (docs/distribution-design.md §3.1, §7): лимит, календарь, режимы, повтор прогона, статусы участников.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { overrideDistributionDepsForTests } from '../../../src/server/domain/distribution/deps';
import { distributeJob } from '../../../src/server/domain/distribution/job';
import { runTick } from '../../../src/server/domain/distribution/tick';
import type { TestDb } from '../../../src/server/platform/db/testing';
import {
  calendar,
  OPERATORS,
  SEED_NOW,
  SEED_TODAY,
  SPACE,
  U,
  closeWorld,
  eventCount,
  logCount,
  makeDeps,
  noteCount,
  openDistributionWorld,
  poolOwnership,
  resetPool,
  seedIssued,
  seedPool,
  system,
  testConfig,
  tickInput,
  uuid,
  type Clock,
} from './helpers';

let db: TestDb;
const clock: Clock = { now: SEED_NOW };

before(async () => {
  db = await openDistributionWorld();
});
after(async () => closeWorld(db));

test('3 оператора × лимит 40, пул 150 → 40/40/40, 30 остаются; журнал, лента и уведомления записаны', async () => {
  await seedPool(db.sql, 150);
  const runId = uuid();
  const report = await runTick(system(), tickInput(clock, runId), makeDeps(clock));
  assert.equal(report.status, 'done');
  assert.deepEqual(Object.values(report.issued).sort(), [40, 40, 40]);
  assert.deepEqual(Object.keys(report.issued).sort(), [...OPERATORS].sort());
  assert.equal(report.assigned, 120);
  assert.equal(report.overCap, 30);
  assert.equal(report.raced, 0);

  const own = await poolOwnership(db.sql);
  assert.equal(own[''], 30);
  assert.equal(own[U.opA], 40);
  const log = await db.sql<{ n: number; toCap: number; runs: number }>`
    SELECT count(*)::int AS n, (count(*) FILTER (WHERE counts_to_cap))::int AS to_cap, count(DISTINCT run_id)::int AS runs
      FROM assign_log WHERE kind = 'auto' AND run_id = ${runId} AND day = ${SEED_TODAY} AND actor_id IS NULL`;
  assert.deepEqual(log[0], { n: 120, toCap: 120, runs: 1 });
  assert.equal(await eventCount(db.sql), 120);
  assert.equal(await noteCount(db.sql), 3);
  const notes = await db.sql<{ userId: string; params: { count: number }; dedupeKey: string }>`SELECT user_id, params, dedupe_key FROM notifications WHERE kind = 'cards_assigned' ORDER BY user_id`;
  assert.deepEqual(notes.map((n) => n.params.count), [40, 40, 40]);
  assert.ok(notes.every((n) => n.dedupeKey === `assign:${runId}:${n.userId}`));
  // версия + 1, assigned_at, touched_in_crm не ставится (D-145)
  const card = (await db.sql<{ version: number; assignedAt: number; touched: boolean }>`
    SELECT version, assigned_at, touched_in_crm AS touched FROM cards WHERE owner_user_id IS NOT NULL AND id LIKE 'pc-%' LIMIT 1`)[0];
  assert.deepEqual(card, { version: 1, assignedAt: SEED_NOW, touched: false });

  // повтор того же runId (воркер упал после коммита) — ничего не добавляется
  const again = await runTick(system(), tickInput(clock, runId), makeDeps(clock));
  assert.deepEqual([again.status, again.reason], ['skipped', 'already_applied']);
  assert.equal(await logCount(db.sql, 'auto'), 120);
  // новый runId: лимит исчерпан
  const next = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.deepEqual([next.status, next.reason], ['skipped', 'no_room']);
  assert.equal(await logCount(db.sql, 'auto'), 120);
});

test('календарь: праздничный понедельник, суббота, 07:00 и 19:00 — тик ничего не пишет', async () => {
  await resetPool(db.sql);
  const slots: Array<[string, number]> = [
    ['26.10 перенос выходного', Date.UTC(2026, 9, 26, 5, 0)],
    ['суббота 31.10', Date.UTC(2026, 9, 31, 6, 0)],
    ['07:00 по Алматы', Date.UTC(2026, 9, 28, 2, 0)],
    ['19:00 по Алматы', Date.UTC(2026, 9, 28, 14, 0)],
  ];
  for (const [label, at] of slots) {
    const c: Clock = { now: at };
    const r = await runTick(system(at), tickInput(c), makeDeps(c));
    assert.deepEqual([r.status, r.reason], ['skipped', 'not_workday_or_window'], label);
  }
  assert.equal(await logCount(db.sql), 0);
  assert.equal((await poolOwnership(db.sql))[''], 150);
});

test('окно проверяется по началу слота: тик 18:00, начатый в 18:00:40, не теряется', async () => {
  await resetPool(db.sql);
  const slotAt = Date.UTC(2026, 9, 28, 13, 0); // 18:00 по Алматы
  const c: Clock = { now: slotAt + 40_000 };
  const r = await runTick(system(c.now), tickInput(c, uuid(), slotAt), makeDeps(c));
  assert.equal(r.status, 'done');
  assert.equal(r.assigned, 120);
});

test('режимы manual и off → тик пропущен, ничего не записано', async () => {
  await resetPool(db.sql);
  for (const mode of ['manual', 'off'] as const) {
    const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ mode })));
    assert.deepEqual([r.status, r.reason], ['skipped', `mode_${mode}`]);
  }
  assert.equal(await logCount(db.sql), 0);
});

test('лимит входит все виды из capIncludes: 25 manual и 5 return → тик даёт 10; «вернуть в пул» лимит не возвращает', async () => {
  await resetPool(db.sql);
  await seedIssued(db.sql, U.opA, 'manual', 25, ['cd-a-1']);
  await seedIssued(db.sql, U.opA, 'return', 5, ['cd-a-2']);
  await seedIssued(db.sql, U.opA, 'release', 5, ['cd-a-3'], false);
  const r = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.equal(r.issued[U.opA], 10);
  assert.equal(r.issued[U.opB], 40);
  assert.equal(r.issued[U.duty], 40);
  assert.equal(r.status, 'done');
});

test('пауза, отсутствие и in_distribution = FALSE: такие сотрудники ничего не получают', async () => {
  await resetPool(db.sql);
  await db.sql`DELETE FROM assign_log`;
  await db.sql`UPDATE memberships SET paused_on = ${SEED_TODAY} WHERE user_id = ${U.opA}`;
  await db.sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, created_at) VALUES ('ab-1', ${SPACE}, ${U.opB}, '2026-10-27', '2026-10-30', ${SEED_NOW})`;
  const r = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.deepEqual(Object.keys(r.issued), [U.duty]);
  assert.equal(r.issued[U.duty], 40);

  // участие выключено → не участник тика
  await resetPool(db.sql);
  await db.sql`UPDATE memberships SET paused_on = '' WHERE user_id = ${U.opA}`;
  await db.sql`UPDATE memberships SET in_distribution = FALSE WHERE user_id = ${U.duty}`;
  const r2 = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.deepEqual(Object.keys(r2.issued), [U.opA]);

  // вчерашняя пауза уже не действует
  await resetPool(db.sql);
  await db.sql`UPDATE memberships SET paused_on = '2026-10-27' WHERE user_id = ${U.opA}`;
  await db.sql`DELETE FROM absences`;
  const r3 = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.deepEqual(Object.keys(r3.issued).sort(), [U.opA, U.opB].sort());

  // никто не работает
  await resetPool(db.sql);
  await db.sql`UPDATE memberships SET in_distribution = FALSE WHERE role_key = 'operator'`;
  const r4 = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.deepEqual([r4.status, r4.reason], ['skipped', 'no_participants']);
  await db.sql`UPDATE memberships SET in_distribution = TRUE, paused_on = '' WHERE role_key = 'operator'`;
});

test('пул пуст → empty_pool; задержанные карточки не раздаются', async () => {
  await resetPool(db.sql);
  await db.sql`UPDATE cards SET hold_reason = 'dup_pair' WHERE id LIKE 'pc-%'`;
  const r = await runTick(system(), tickInput(clock), makeDeps(clock));
  assert.deepEqual([r.status, r.reason], ['skipped', 'empty_pool']);
  await db.sql`UPDATE cards SET hold_reason = '' WHERE id LIKE 'pc-%'`;
});

test('top_up: держит не больше K новых у каждого', async () => {
  await resetPool(db.sql);
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ mode: 'top_up', topUpKeep: 7 })));
  assert.deepEqual(Object.values(r.issued), [7, 7, 7]);
});

test('мобильные раньше городских (queue.mobileFirst)', async () => {
  await resetPool(db.sql);
  await db.sql`UPDATE client_phones SET kind = 'landline' WHERE client_id IN (SELECT client_id FROM cards WHERE id IN ('pc-1', 'pc-2', 'pc-3'))`;
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 1 })));
  assert.equal(r.assigned, 3);
  const own = await db.sql<{ id: string }>`SELECT id FROM cards WHERE id IN ('pc-1','pc-2','pc-3') AND owner_user_id IS NOT NULL`;
  assert.equal(own.length, 0, 'городские не выданы, пока есть мобильные');
  await db.sql`UPDATE client_phones SET kind = 'mobile'`;
});

test('задача воркера: прогон тика с подменой настроек, статистика только числа; вне окна — skipped с кодом', async () => {
  await resetPool(db.sql);
  overrideDistributionDepsForTests(makeDeps(clock));
  try {
    const ctx = (at: number) => ({
      actor: system(at),
      runId: uuid(),
      slot: { key: 'slot', at },
      attempt: 1,
      now: at,
      signal: new AbortController().signal,
      space: { id: SPACE, key: 'sales' },
      calendar,
      log: { info() {}, warn() {} },
    });
    const ok = await distributeJob.handler(ctx(SEED_NOW));
    assert.equal(ok.status, 'ok');
    assert.equal(ok.stats.assigned, 120);
    assert.ok(Object.values(ok.stats).every((v) => typeof v === 'number'));
    const night = Date.UTC(2026, 9, 28, 2, 0);
    overrideDistributionDepsForTests(makeDeps({ now: night }));
    const skipped = await distributeJob.handler(ctx(night));
    assert.deepEqual([skipped.status, skipped.note], ['skipped', 'not_workday_or_window']);
  } finally {
    overrideDistributionDepsForTests(null);
  }
});
