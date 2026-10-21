// Передача в отдел при покупке (B6, §5.6, D-250): срок — конец рабочего дня через acceptSlaWorkdays рабочих дней
// (праздник пропускается), без руководителя — задача РОП «Назначьте руководителя отдела», отдел в архиве —
// передачи нет, покупка проходит.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '../../../packages/core/src';
import type { Viewer } from '../../../src/server/access/types';
import { registerPurchase } from '../../../src/server/domain/deals/purchase';
import type { DealsDeps } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_TZ } from '../../isolation/harness/seed';
import { TEAM_MKT, THU_14, U, closeDealsWorld, makeDealsDeps, openDealsWorld, uuid, viewerOf } from './helpers';

let db: TestDb;
let rop: Viewer;
const clock = { now: THU_14 };
const buy = (deps: DealsDeps, n: number, serviceTypeKey: string) => registerPurchase(deps, rop, { requestId: uuid(), cardId: `cd-b-${n}`, dealId: null, serviceTypeKey, amountKzt: 1000, wonDay: null });

before(async () => {
  db = await openDealsWorld();
  rop = await viewerOf(U.rop);
});
after(() => closeDealsWorld(db));

test('срок через праздник: пятница выходная → понедельник 18:00', async () => {
  const deps = makeDealsDeps(clock, (s) => ({
    ...s,
    calendar: time.createWorkCalendar({
      timezone: SEED_TZ,
      workdays: [1, 2, 3, 4, 5],
      workHours: { start: '09:00', end: '18:00' },
      callWindow: { start: '09:00', end: '18:00' },
      holidays: [{ date: '2026-10-30', kind: 'holiday' }],
    }),
  }));
  const r = await buy(deps, 80, 'smm');
  const h = await db.sql<{ dueAt: number }>`SELECT due_at FROM handoffs WHERE id = ${r.handoffId!}`;
  assert.equal(h[0]?.dueAt, Date.UTC(2026, 10, 2, 13, 0));
});

test('руководитель не назначен → задача РОП «Назначьте руководителя отдела», передача ждёт, оператору — ничего', async () => {
  await db.sql`UPDATE teams SET lead_user_id = NULL WHERE id = ${TEAM_MKT}`;
  try {
    const r = await buy(makeDealsDeps(clock), 81, 'smm');
    const h = await db.sql<{ status: string }>`SELECT status FROM handoffs WHERE id = ${r.handoffId!}`;
    assert.equal(h[0]?.status, 'pending');
    const tasks = await db.sql<{ sourceKey: string; kind: string; assigneeUserId: string }>`SELECT * FROM tasks WHERE deal_id = ${r.deal.id} AND source = 'handoff'`;
    assert.deepEqual(tasks.map((x) => [x.sourceKey, x.kind, x.assigneeUserId]), [[`handoff_nolead:${r.handoffId}`, 'check', U.rop]]);
  } finally {
    await db.sql`UPDATE teams SET lead_user_id = ${U.mktHead} WHERE id = ${TEAM_MKT}`;
  }
});

test('руководитель отключён — как нет руководителя', async () => {
  await db.sql`UPDATE memberships SET status = 'disabled' WHERE user_id = ${U.mktHead}`;
  try {
    const r = await buy(makeDealsDeps(clock), 82, 'smm');
    const keys = await db.sql<{ sourceKey: string }>`SELECT source_key FROM tasks WHERE deal_id = ${r.deal.id} AND source = 'handoff'`;
    assert.deepEqual(keys.map((k) => k.sourceKey), [`handoff_nolead:${r.handoffId}`]);
  } finally {
    await db.sql`UPDATE memberships SET status = 'active' WHERE user_id = ${U.mktHead}`;
  }
});

test('отдел в архиве → передачи нет, покупка прошла', async () => {
  // отделы настроек проецируются в таблицу teams; архивный отдел передачу не принимает
  await db.sql`UPDATE teams SET archived_at = ${THU_14} WHERE space_id = 'sp-sales' AND key = 'design'`;
  const r = await buy(makeDealsDeps(clock), 83, 'design');
  assert.deepEqual([r.deal.status, r.handoffId], ['won', null]);
  assert.equal((await db.sql`SELECT 1 FROM handoffs WHERE deal_id = ${r.deal.id}`).length, 0);
});

test('лента: handoff.created с кодами отдела и услуги', async () => {
  const r = await buy(makeDealsDeps(clock), 85, 'smm');
  const feed = await db.sql<{ data: Record<string, unknown>; refType: string }>`SELECT data, ref_type FROM client_events WHERE deal_id = ${r.deal.id} AND kind = 'handoff.created'`;
  assert.deepEqual([feed[0]?.refType, feed[0]?.data], ['handoff', { handoffId: r.handoffId, teamKey: 'marketing', serviceTypeKey: 'smm' }]);
});
