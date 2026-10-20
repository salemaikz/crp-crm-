// Каскад отмены мероприятия с настоящим портом карточки (C5): события карточек идут от системы, а не с охватом
// отменяющего (docs/booking-design.md §7.1, backlog «каскад и CardPort»).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { testViewer } from '../../../src/server/access/testing';
import type { Viewer } from '../../../src/server/access/types';
import { cancelEvent } from '../../../src/server/domain/booking/events';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, TEAM_MKT, U } from '../../isolation/harness/seed';
import { presetRole } from '../../unit/access/helpers';
import { seedBookings, seedEvent } from '../booking/helpers';
import { SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, uuid } from './world';

let db: TestDb;
let booking: BookingDeps;

before(async () => {
  db = await openCallsWorld();
  booking = callsDeps({ now: SEED_NOW }).booking();
});
after(() => closeCallsWorld(db));

test('отмена мероприятия руководителем с охватом team: карточки чужих владельцев переходят системно, без отказа', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id IN ('cd-a-85', 'cd-a-86', 'cd-a-87')`;
  await seedEvent(db.sql, { id: 'ev-cc', date: '2026-11-12', time: '15:00' });
  const guests = [85, 86, 87].map((i) => ({ client: `cl-a-${i}`, card: `cd-a-${i}` }));
  await seedBookings(db.sql, 'ev-cc', guests);
  // одна карточка в команде отменяющего, остальные (оператор A) — вне её
  await db.sql`UPDATE cards SET owner_user_id = ${U.marketer} WHERE id = 'cd-a-85'`;
  const teamMgr: Viewer = testViewer({
    userId: U.mktHead,
    role: { ...presetRole('rop'), grants: presetRole('rop').grants.map((g) => ({ ...g, scope: 'team' as const })) },
    spaceId: SPACE,
    teamId: TEAM_MKT,
    now: SEED_NOW,
    timeZone: 'UTC',
  });
  const r = await cancelEvent(booking, teamMgr, { eventId: 'ev-cc', opId: uuid() });
  assert.equal(r.cancelledBookings, 3);
  const cards = await db.sql<{ id: string; state: string }>`SELECT id, state FROM cards WHERE id IN ('cd-a-85', 'cd-a-86', 'cd-a-87') ORDER BY id`;
  assert.deepEqual(cards.map((c) => c.state), ['callback', 'callback', 'callback'], 'без других будущих записей карточка возвращается в обзвон');
  // события карточек записаны от системы: сотрудника в ленте состояния нет
  const ev = await db.sql<{ actorId: string | null }>`SELECT actor_id FROM client_events WHERE kind = 'card.state' AND client_id IN ('cl-a-85', 'cl-a-86', 'cl-a-87')`;
  assert.equal(ev.length, 3);
  assert.ok(ev.every((e) => e.actorId === null));
});
