// Итог по переданной карточке (D-175, D-223, D-224): сотрудник с охватом team, чья бывшая карточка теперь вне
// его охвата, получает только факт owner_changed — состояние чужой карточки и её сделки не меняются; свой
// повтор того же opId после передачи и позже окна офлайна — duplicate, а не 404.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { testViewer } from '../../../src/server/access/testing';
import type { Viewer } from '../../../src/server/access/types';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, TEAM_MKT, U } from '../../isolation/harness/seed';
import { presetRole } from '../../unit/access/helpers';
import { DAY, HOUR, MIN, SEED_NOW, callsDeps, cardOf, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };

const cnt = async (q: Promise<Array<{ n: number }>>): Promise<number> => (await q)[0]!.n;

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
});
after(() => closeCallsWorld(db));

test('охват team: офлайн-итог по своей бывшей карточке, переданной в другую команду, — только факт owner_changed', async () => {
  clock.now = SEED_NOW;
  // Роль с card.outcome: team (схема настроек это допускает, в пресетах ЦРП такой роли нет)
  const teamMgr: Viewer = testViewer({
    userId: U.mktHead,
    role: { ...presetRole('rop'), grants: presetRole('rop').grants.map((g) => ({ ...g, scope: 'team' as const })) },
    spaceId: SPACE,
    teamId: TEAM_MKT,
    now: SEED_NOW,
    timeZone: 'UTC',
  });
  await setCard(db.sql, 'cd-a-40', { state: 'retry', attempts: 1, nextCallAt: SEED_NOW - HOUR, lastOutcomeAt: null, owner: U.opA });
  // карточка была за руководителем, затем передана оператору A (не из его команды)
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-t-1', ${SPACE}, 'cd-a-40', NULL, ${U.mktHead}, 'manual', FALSE, '2026-10-28', ${SEED_NOW - 40 * MIN}),
                      ('al-t-2', ${SPACE}, 'cd-a-40', ${U.mktHead}, ${U.opA}, 'transfer', FALSE, '2026-10-28', ${SEED_NOW - 20 * MIN})`;
  const t = SEED_NOW - DAY;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
               VALUES ('dl-t-1', ${SPACE}, 'sales', 'booked', 'open', 'cl-a-40', 'cd-a-40', ${U.opA}, ${t}, ${t}, ${t})`;
  const before = await cardOf(db.sql, 'cd-a-40');

  const req = outcomeReq({ cardId: 'cd-a-40', outcomeKey: 'not_interested', reasonCode: 'expensive', via: 'offline', occurredAt: SEED_NOW - 30 * MIN });
  const r = await submitOutcome(deps, teamMgr, req);
  assert.deepEqual([r.status, r.factReason, r.card], ['fact_only', 'owner_changed', null]);

  // состояние чужой карточки не сдвинуто, сделка открыта, проигрыша в ленте нет
  const card = await cardOf(db.sql, 'cd-a-40');
  assert.deepEqual([card.state, card.ownerUserId, card.lastOutcomeCode, card.nextCallAt], [before.state, U.opA, before.lastOutcomeCode, before.nextCallAt]);
  const [deal] = await db.sql<{ status: string }>`SELECT status FROM deals WHERE id = 'dl-t-1'`;
  assert.equal(deal?.status, 'open');
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE client_id = 'cl-a-40' AND kind = 'deal.lost'`), 0);
  // звонок записан фактом, текущему владельцу — задача разобрать
  const [call] = await db.sql<{ applied: string; factReason: string }>`SELECT applied, fact_reason FROM calls WHERE id = ${req.opId}`;
  assert.deepEqual([call?.applied, call?.factReason], ['fact_only', 'owner_changed']);
  const tasks = await db.sql<{ assigneeUserId: string }>`SELECT assignee_user_id FROM tasks WHERE source_key = ${`review:${req.opId}`}`;
  assert.deepEqual(tasks.map((x) => x.assigneeUserId), [U.opA]);
});

test('свой повтор opId после передачи и позже окна офлайна — duplicate без карточки, не 404', async () => {
  clock.now = SEED_NOW;
  await setCard(db.sql, 'cd-a-41', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null, owner: U.opA });
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-t-3', ${SPACE}, 'cd-a-41', NULL, ${U.opA}, 'manual', FALSE, '2026-10-28', ${SEED_NOW - 2 * HOUR})`;
  const req = outcomeReq({ cardId: 'cd-a-41', via: 'offline', occurredAt: SEED_NOW - MIN });
  const first = await submitOutcome(deps, opA, req);
  assert.equal(first.status, 'applied');

  // ответ потерялся; карточку передали B; устройство повторяет через 10 дней
  await db.sql`UPDATE cards SET owner_user_id = ${U.opB} WHERE id = 'cd-a-41'`;
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-t-4', ${SPACE}, 'cd-a-41', ${U.opA}, ${U.opB}, 'transfer', FALSE, '2026-10-28', ${SEED_NOW + HOUR})`;
  clock.now = SEED_NOW + 10 * DAY;
  const again = await submitOutcome(deps, opA, req);
  assert.deepEqual([again.status, again.applied, again.card], ['duplicate', 'applied', null]);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE card_id = 'cd-a-41'`), 1);
  clock.now = SEED_NOW;
});
