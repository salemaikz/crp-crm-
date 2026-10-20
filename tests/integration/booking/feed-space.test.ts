// Лента клиента получает записи и сделки (реестр видов), запись только в мероприятие своего пространства,
// каскад отмены мероприятия не зависит от охвата отменяющего.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { testViewer } from '../../../src/server/access/testing';
import type { Viewer } from '../../../src/server/access/types';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { cancelEvent } from '../../../src/server/domain/booking/events';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import { getClientFeed } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, TEAM_MKT, U } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from '../clients/world';
import { presetRole } from '../../unit/access/helpers';
import { SEED_NOW as NOW, clientsOf, fakeCardPort, makeDeps, seedBookings, seedEvent, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
const port = fakeCardPort();

before(async () => {
  db = await openClientsWorld();
  await db.sql`UPDATE cards SET state = 'agreed'`;
  deps = makeDeps({ now: NOW }, port);
});
after(() => closeClientsWorld(db));

test('лента: после записи и сделки группы bookings и deals непустые, данные — по реестру', async () => {
  const opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'ev-feed', date: '2026-11-05', time: '15:00' });
  const c = clientsOf('a', 70, 70)[0]!;
  await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: c.client, eventId: 'ev-feed', contactId: null });
  const bookings = await getClientFeed(opA, c.client, { cursor: null, groups: 'bookings' });
  assert.ok(bookings.items.length > 0);
  assert.ok(bookings.items.every((i) => i.group === 'bookings'));
  const created = bookings.items.find((i) => i.kind === 'booking.created');
  assert.equal(created?.data.eventId, 'ev-feed');
  const deals = await getClientFeed(opA, c.client, { cursor: null, groups: 'deals' });
  assert.ok(deals.items.some((i) => i.kind === 'deal.created' && typeof i.data.dealId === 'string'));
});

test('запись в мероприятие другого пространства — event_not_found', async () => {
  await db.sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES ('sp-other', 'other', FALSE, ${SEED_NOW})`;
  await db.sql`
    INSERT INTO events (id, space_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, touched, created_at, updated_at)
    SELECT 'ev-foreign', 'sp-other', event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, touched, created_at, updated_at
      FROM events WHERE id = 'ev-feed'`;
  // сотрудник с охватом «все пространства»: мероприятие ему видно, но запись идёт в его текущее пространство
  const wide = testViewer({
    userId: U.rop,
    role: { ...presetRole('rop'), grants: presetRole('rop').grants.map((g) => ({ ...g, scope: 'all' as const })) },
    spaceId: SPACE,
    spaceIds: [SPACE, 'sp-other'],
    now: NOW,
    timeZone: 'UTC',
  });
  const c = clientsOf('a', 71, 71)[0]!;
  await assert.rejects(
    createBooking(deps, wide, { kind: 'group', requestId: uuid(), clientId: c.client, eventId: 'ev-foreign', contactId: null }),
    (e: unknown) => e instanceof BookingDomainError && e.code === 'event_not_found',
  );
  const n = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = 'ev-foreign'`;
  assert.equal(n[0]?.n, 0);
});

test('отмена мероприятия отменяет все активные записи, даже вне охвата отменяющего (team)', async () => {
  await seedEvent(db.sql, { id: 'ev-scope', date: '2026-11-12', time: '15:00' });
  const all = clientsOf('a', 80, 82);
  await seedBookings(db.sql, 'ev-scope', all);
  // одна карточка принадлежит команде отменяющего, остальные — нет
  await db.sql`UPDATE cards SET owner_user_id = ${U.marketer} WHERE id = ${all[0]!.card}`;
  const teamMgr: Viewer = testViewer({
    userId: U.mktHead,
    role: { ...presetRole('rop'), grants: presetRole('rop').grants.map((g) => ({ ...g, scope: 'team' as const })) },
    spaceId: SPACE,
    teamId: TEAM_MKT,
    now: NOW,
    timeZone: 'UTC',
  });
  const r = await cancelEvent(deps, teamMgr, { eventId: 'ev-scope', opId: uuid() });
  assert.equal(r.cancelledBookings, 3);
  const left = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = 'ev-scope' AND status <> 'cancelled'`;
  assert.equal(left[0]?.n, 0);
});
