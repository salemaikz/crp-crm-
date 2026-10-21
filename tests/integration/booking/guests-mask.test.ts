// Список гостей: у гостя без записи нет имени, контакта, хвоста номера и автора (B4, §2.7, D-241).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { listGuests } from '../../../src/server/domain/booking/events';
import { registerWalkIn } from '../../../src/server/domain/booking/walkIn';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeDutyWorld, fakeCardPort, makeDeps, openDutyWorld, seedBookings, seedEvent, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let duty: Viewer;
let rop: Viewer;

before(async () => {
  db = await openDutyWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
  duty = await viewerOf(U.duty);
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'ev-g', date: '2026-10-28', time: '09:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('ev-g', ${U.duty}, ${SEED_NOW})`;
});
after(() => closeDutyWorld(db));

test('гость без записи в JSON списка — без имени, контакта, хвоста номера и автора, и в конце списка', async () => {
  await seedBookings(db.sql, 'ev-g', clientsOf('a', 1, 2), { bookedBy: U.opA });
  const r = await registerWalkIn(deps, duty, { eventId: 'ev-g', requestId: uuid(), phone: '+7 709 123 45 67', name: 'Гостья Секретная', company: 'ТОО Секретная Компания' });
  assert.equal(r.answer, 'new');
  // найденный по номеру клиент тоже скрыт: он «без записи» на этом мероприятии
  const found = await registerWalkIn(deps, duty, { eventId: 'ev-g', requestId: uuid(), phone: '+7 709 000 00 05', name: 'Гость', company: '' });
  assert.equal(found.answer, 'found');

  for (const who of [duty, rop]) {
    const rows = await listGuests(deps, who, 'ev-g');
    assert.equal(rows.length, 4);
    const walk = rows.filter((x) => x.via === 'walk_in');
    assert.equal(walk.length, 2);
    for (const w of walk) assert.deepEqual([w.clientName, w.contactName, w.phoneTail, w.bookedByName], ['', '', '', '']);
    assert.deepEqual(rows.map((x) => x.via === 'walk_in'), [false, false, true, true], 'гости без записи идут последними');
    const text = JSON.stringify(rows);
    assert.equal(text.includes('Секретн'), false);
    assert.equal(text.includes('4567'), false);
    assert.equal(text.includes('Синтетика Альфа 5'), false, 'название найденного по номеру клиента не показано');
  }
  const named = (await listGuests(deps, duty, 'ev-g')).filter((x) => x.via !== 'walk_in');
  assert.ok(named.every((x) => x.clientName !== '' && x.phoneTail !== ''), 'обычные гости видны как раньше');
});
