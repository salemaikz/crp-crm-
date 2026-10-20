// Серии мероприятий и синхронизация (B2, §5.5, D-135): праздник пропускается, повтор ничего не меняет,
// тронутые мероприятия не перегенерируются, лишние «снимаются», отменённое не возвращается.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '../../../packages/core/src';
import { ConflictError, ForbiddenError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { systemActor } from '../../../src/server/access/systemActor';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { cancelEvent, listEvents, setEventDuty, updateEvent } from '../../../src/server/domain/booking/events';
import { createSeries, ensureAllSeries, listSeries, syncSeries, updateSeries } from '../../../src/server/domain/booking/series';
import type { BookingDeps, SeriesInput } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { CALENDAR_SETTINGS, SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, testSettings, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let opA: Viewer;

before(async () => {
  db = await openBookingWorld();
  // 12.11.2026 (четверг) — праздничный день календаря
  const calendar = time.createWorkCalendar({ ...CALENDAR_SETTINGS, holidays: [{ date: '2026-11-12', kind: 'holiday' }] });
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort(), testSettings({ calendar }));
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
});
after(() => closeWorld(db));

const input = (weekday: number, over: Partial<SeriesInput> = {}): SeriesInput & { requestId: string } => ({
  requestId: uuid(),
  eventTypeKey: 'br',
  weekday,
  startTime: '15:00',
  durationMin: 180,
  location: 'Зал 1',
  format: 'offline',
  capacity: 30,
  ...over,
});

const eventsOf = (seriesId: string) =>
  db.sql<{ id: string; eventDate: string; startTime: string; startsAt: number; status: string; occurrenceKey: string | null; capacity: number }>`
    SELECT id, event_date, start_time, starts_at, status, occurrence_key, capacity FROM events WHERE series_id = ${seriesId} ORDER BY event_date, id`;
const live = async (seriesId: string) => (await eventsOf(seriesId)).filter((e) => e.occurrenceKey !== null || e.status === 'scheduled');

test('серия «чт 15:00» на 28 дней с праздником в четверг: 3 мероприятия и 1 пропуск; повторная синхронизация — 0 изменений', async () => {
  const { series, sync } = await createSeries(deps, rop, input(4));
  assert.deepEqual([sync.created, sync.updated, sync.retired], [3, 0, 0]);
  assert.deepEqual(sync.skipped, [{ date: '2026-11-12', reason: 'non_workday' }]);
  assert.deepEqual(series.skipped, sync.skipped);
  const evs = await eventsOf(series.id);
  assert.deepEqual(evs.map((e) => e.eventDate), ['2026-10-29', '2026-11-05', '2026-11-19']);
  assert.ok(evs.every((e) => e.startTime === '15:00' && e.status === 'scheduled' && e.occurrenceKey?.startsWith(series.id)));

  const again = await syncSeries(deps, systemActor('events-ensure', SEED_NOW), series.id);
  assert.deepEqual([again.created, again.updated, again.retired], [0, 0, 0]);
  assert.equal((await eventsOf(series.id)).length, 3);

  const listed = (await listSeries(deps, rop)).find((s) => s.id === series.id);
  assert.deepEqual(listed?.skipped, sync.skipped, 'РОП видит пропущенную дату');
  const audit = await db.sql<{ action: string }>`SELECT action FROM audit_log WHERE entity = 'series' AND entity_id = ${series.id}`;
  assert.deepEqual(audit.map((a) => a.action), ['series.create']);
});

test('повтор ключа серии — одна серия; тот же ключ с другим содержимым — request_reused', async () => {
  const body = input(3);
  const a = await createSeries(deps, rop, body);
  const b = await createSeries(deps, rop, body);
  assert.equal(a.series.id, b.series.id);
  assert.deepEqual([b.sync.created, b.sync.updated, b.sync.retired], [0, 0, 0]);
  const n = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM event_series WHERE id = ${body.requestId}`)[0]?.n;
  assert.equal(n, 1);
  await assert.rejects(createSeries(deps, rop, { ...body, capacity: 12 }), (e: unknown) => e instanceof BookingDomainError && e.code === 'request_reused');
});

test('смена времени: нетронутые обновлены; с записью, дежурным и ручной правкой — нет', async () => {
  const { series } = await createSeries(deps, rop, input(5)); // пятницы: 30.10, 06.11, 13.11, 20.11
  const [free, withBooking, withDuty, edited] = await eventsOf(series.id);
  assert.equal((await eventsOf(series.id)).length, 4);
  await seedBookings(db.sql, withBooking!.id, [{ client: 'cl-a-1', card: 'cd-a-1' }]);
  await setEventDuty(deps, rop, { eventId: withDuty!.id, userIds: [U.duty] });
  await updateEvent(deps, rop, { eventId: edited!.id, seenUpdatedAt: (await db.sql<{ u: number }>`SELECT updated_at AS u FROM events WHERE id = ${edited!.id}`)[0]!.u, patch: { capacity: 25 } });

  const seen = (await listSeries(deps, rop)).find((s) => s.id === series.id)!.updatedAt;
  const r = await updateSeries(deps, rop, { seriesId: series.id, seenUpdatedAt: seen, patch: { startTime: '16:00', capacity: 40 } });
  assert.deepEqual([r.sync.created, r.sync.updated, r.sync.retired], [0, 1, 0]);
  const after = new Map((await eventsOf(series.id)).map((e) => [e.id, e]));
  assert.deepEqual([after.get(free!.id)?.startTime, after.get(free!.id)?.capacity], ['16:00', 40]);
  for (const e of [withBooking!, withDuty!]) assert.deepEqual([after.get(e.id)?.startTime, after.get(e.id)?.capacity], ['15:00', 30], 'запись/дежурный — не трогаем');
  assert.deepEqual([after.get(edited!.id)?.startTime, after.get(edited!.id)?.capacity], ['15:00', 25], 'ручная правка — не трогаем');
  assert.equal(after.get(free!.id)?.startsAt, (await db.sql<{ s: number }>`SELECT starts_at AS s FROM events WHERE id = ${free!.id}`)[0]?.s);
  // устаревший токен правки серии
  await assert.rejects(updateSeries(deps, rop, { seriesId: series.id, seenUpdatedAt: seen, patch: { capacity: 10 } }), (e: unknown) => e instanceof ConflictError);
});

test('смена дня недели: нетронутые старые «сняты» (ключ освобождён), новые созданы; возврат дня создаёт заново', async () => {
  const { series } = await createSeries(deps, rop, input(1)); // понедельники: 02.11, 09.11, 16.11, 23.11
  const first = await eventsOf(series.id);
  assert.equal(first.length, 4);
  let seen = (await listSeries(deps, rop)).find((s) => s.id === series.id)!.updatedAt;
  const toTue = await updateSeries(deps, rop, { seriesId: series.id, seenUpdatedAt: seen, patch: { weekday: 2 } });
  assert.deepEqual([toTue.sync.created, toTue.sync.retired], [4, 4]);
  const retired = (await eventsOf(series.id)).filter((e) => first.some((f) => f.id === e.id));
  assert.ok(retired.every((e) => e.status === 'cancelled' && e.occurrenceKey === null), 'снятые: cancelled и без ключа');

  // снятые не видны в списках
  const visible = await listEvents(deps, rop, { from: '2026-10-28', to: '2026-11-25', includeCancelled: true });
  assert.ok(!visible.some((e) => retired.some((r) => r.id === e.id)));
  assert.ok(visible.some((e) => e.seriesId === series.id && e.status === 'scheduled'));

  seen = toTue.series.updatedAt;
  const back = await updateSeries(deps, rop, { seriesId: series.id, seenUpdatedAt: seen, patch: { weekday: 1 } });
  assert.deepEqual([back.sync.created, back.sync.retired], [4, 4], 'возврат понедельника создаёт мероприятия снова');
  const mondays = (await eventsOf(series.id)).filter((e) => e.status === 'scheduled' && e.occurrenceKey !== null);
  assert.deepEqual(mondays.map((e) => e.eventDate), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
});

test('серия неактивна → нетронутые будущие сняты; включена снова → созданы', async () => {
  const { series } = await createSeries(deps, rop, input(6)); // субботы нерабочие: пропуски, мероприятий нет
  assert.equal((await live(series.id)).length, 0);
  assert.equal(series.skipped.length, 4);
  const midweek = await createSeries(deps, rop, input(3, { startTime: '16:00' }));
  assert.equal((await live(midweek.series.id)).length, 4);
  const off = await updateSeries(deps, rop, { seriesId: midweek.series.id, seenUpdatedAt: midweek.series.updatedAt, patch: { active: false } });
  assert.deepEqual([off.sync.created, off.sync.retired], [0, 4]);
  assert.equal((await live(midweek.series.id)).length, 0);
  const on = await updateSeries(deps, rop, { seriesId: midweek.series.id, seenUpdatedAt: off.series.updatedAt, patch: { active: true } });
  assert.deepEqual([on.sync.created, on.sync.retired], [4, 0]);
});

test('отменённое РОП мероприятие серии не возвращается синхронизацией', async () => {
  const { series } = await createSeries(deps, rop, input(2, { startTime: '12:00', location: 'Зал 2' }));
  const evs = await eventsOf(series.id);
  const victim = evs[0]!;
  await cancelEvent(deps, rop, { eventId: victim.id, opId: uuid() });
  const r = await syncSeries(deps, systemActor('events-ensure', SEED_NOW), series.id);
  assert.deepEqual([r.created, r.updated, r.retired], [0, 0, 0]);
  const row = (await eventsOf(series.id)).find((e) => e.id === victim.id)!;
  assert.deepEqual([row.status, row.occurrenceKey !== null], ['cancelled', true], 'ключ сохранён: дата не занимается заново');
  assert.equal((await eventsOf(series.id)).length, evs.length);
});

test('задание events-ensure: все активные серии; второй прогон ничего не меняет', async () => {
  const first = await ensureAllSeries(deps, systemActor('events-ensure', SEED_NOW));
  assert.ok(first.length > 0);
  const second = await ensureAllSeries(deps, systemActor('events-ensure', SEED_NOW));
  assert.equal(second.length, first.length);
  assert.ok(second.every((r) => r.created === 0 && r.updated === 0 && r.retired === 0));
});

test('оператор не управляет сериями (403), чужое пространство серии недоступно', async () => {
  await assert.rejects(createSeries(deps, opA, input(4)), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(listSeries(deps, opA), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(updateSeries(deps, rop, { seriesId: 'no-such-series', seenUpdatedAt: 0, patch: {} }), (e: unknown) => e instanceof BookingDomainError && e.code === 'series_not_found');
  await assert.rejects(createSeries(deps, rop, input(4, { eventTypeKey: 'unknown_type' })), (e: unknown) => e instanceof BookingDomainError && e.code === 'invalid_settings');
});
