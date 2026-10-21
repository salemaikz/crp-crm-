/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД и ответы читаются по путям */
// Профиль «Записи» (D-324) на Postgres, случаи ревью C4b: тот же клиент на два групповых вида, XLSX с ячейками
// времени и «дата и время», мероприятие сегодня уже началось, длинный ярлык оператора и предел числа авторов.
// Только синтетика (+7 709 …, выдуманные компании и подписи).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { imports } from '@crm/core';
import { PreviewBody } from '../../../src/app/api/import/_lib';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { importApi, type BookingApplyResult, type BookingPreviewSummary } from '../../../src/server/domain/import';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { xlsx, type Cell } from '../../unit/import/xlsxBuilder';
import { BOOKINGS_PROFILE, SNAPSHOT, T0, actorOf, installBookingsConfig, makeBookingsWorld, mkClient, mkEvent, upload, type BookingsWorld } from './bookingsWorld';

let db: TestDb;
let w: BookingsWorld;
const NOW = T0 + 10_000;
let tick = 0;
const t = () => NOW + 1000 * ++tick;

/** Второй групповой вид установки (штатная настройка тиражного продукта) и его подпись в карте профиля. */
const G2 = { key: 'gx2', label: 'Группа-Синтетик-2' };
const DAY2 = '2026-11-11';

const HEAD = ['Наименование', 'Телефон', 'БИН', 'Дата', 'Время', 'Оператор', 'Мероприятие'];
let phoneSeq = 500;
const ph = () => `+7 709 ${++phoneSeq} 00 22`;
type Row = { name: string; phone: string; date?: string; time?: string; op?: string; type?: string };
const line = (r: Row): string[] => [r.name, r.phone, '', r.date ?? '05.11.2026', r.time ?? '', r.op ?? 'Оператор-01', r.type ?? 'БР'];
const authors = (): Record<string, string | null> => ({ 'Оператор-01': w.staff.op1, 'Оператор-02': w.staff.op2 });

before(async () => {
  db = await createTestDb();
  w = await makeBookingsWorld(db);
  await installBookingsConfig((d) => {
    const types = d.spaces.sales.booking.eventTypes as Record<string, any>[];
    const group = types.find((x) => x.behavior === 'group');
    types.push({ ...structuredClone(group), key: G2.key, label: { ru: G2.label }, short: { ru: G2.label } });
    const profile = (d.spaces.sales.import.profiles as Record<string, any>[]).find((p) => p.key === BOOKINGS_PROFILE);
    profile!.valueMaps.eventType[G2.label] = G2.key;
  });
});
after(async () => {
  resetAccessForTests();
  await db.close();
});

async function preview(grid: readonly (readonly string[])[], map = authors(), body?: Uint8Array) {
  const actor = await actorOf(w);
  const up = body
    ? await importApi.upload(actor, { profileKey: BOOKINGS_PROFILE, snapshotDay: SNAPSHOT, fileName: 'записи.xlsx', body }, t())
    : await upload(actor, grid, { now: t() });
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: map }, t())) as BookingPreviewSummary;
  return { actor, up, s };
}
const applyOf = async (x: Awaited<ReturnType<typeof preview>>, map = authors()) =>
  (await importApi.apply(x.actor, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: map }, t())) as BookingApplyResult;
async function actionsOf(importId: string): Promise<string[]> {
  const r = await importApi.listRows(await actorOf(w), importId, { filter: 'all', offset: 0, limit: 200 }, t());
  return (r.rows as any[]).map((x) => x.action);
}
const phoneOf = async (clientId: string) => (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${clientId}`)[0].digits as string;
const bookingsOf = (clientId: string) => db.sql<any>`SELECT event_id, booked_by_user_id FROM bookings WHERE client_id = ${clientId} ORDER BY created_at, id`;
const cardOf = async (cardId: string) => (await db.sql<any>`SELECT * FROM cards WHERE id = ${cardId}`)[0];

// ---------- два групповых вида ----------

test('тот же клиент на два групповых вида в один день: применение проходит, карточка переведена один раз', async () => {
  const brEvent = await mkEvent(db, w.spaceId, { date: DAY2, time: '12:00' });
  const g2Event = await mkEvent(db, w.spaceId, { date: DAY2, time: '18:00', type: G2.key });
  const owned = await mkClient(db, w.spaceId, { name: 'ТОО «Два-Вида-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const unowned = await mkClient(db, w.spaceId, { name: 'ТОО «Два-Вида-2»', phone: ph(), state: 'new', ownerUserId: null });
  const rowsOf = async (c: { clientId: string }, name: string): Promise<Row[]> => {
    const phone = await phoneOf(c.clientId);
    return [
      { name, phone, date: '11.11.2026', type: 'БР' },
      { name, phone, date: '11.11.2026', type: G2.label },
    ];
  };
  const rows = [...(await rowsOf(owned, 'ТОО «Два-Вида-1»')), ...(await rowsOf(unowned, 'ТОО «Два-Вида-2»'))];
  const x = await preview([HEAD, ...rows.map(line)]);
  assert.deepEqual(await actionsOf(x.up.importId), ['create', 'create', 'create', 'create']);
  assert.deepEqual(x.s.blockers, []);
  assert.equal(x.s.willAgree, 2, 'по одному переходу на карточку');
  const res = await applyOf(x);
  assert.deepEqual([res.written.bookingsCreated, res.written.cardsAgreed, res.written.ownersAssigned], [4, 2, 1]);
  for (const c of [owned, unowned]) {
    assert.deepEqual((await bookingsOf(c.clientId)).map((b) => b.eventId).sort(), [brEvent, g2Event].sort());
    const card = await cardOf(c.cardId);
    assert.deepEqual([card.state, card.ownerUserId], ['agreed', w.staff.op1]);
  }
  const [log] = await db.sql<any>`SELECT count(*)::int AS n FROM assign_log WHERE card_id = ${unowned.cardId}`;
  assert.equal(log.n, 1, 'владелец назначен один раз');
});

// ---------- XLSX ----------

test('XLSX: «Время» в формате h:mm и «Дата» в формате dd.mm.yyyy hh:mm — записи на нужные мероприятия, без ошибок разбора', async () => {
  // 46336 = 2026-11-10 (DAYS.twoEvents: мероприятия 12:00 и 18:00); .5 = 12:00, .75 = 18:00
  const a = await mkClient(db, w.spaceId, { name: 'ТОО «Икс-Эл-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const b = await mkClient(db, w.spaceId, { name: 'ТОО «Икс-Эл-2»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const rows: Cell[][] = [
    HEAD,
    ['ТОО «Икс-Эл-1»', await phoneOf(a.clientId), null, { date: 46336 }, { time: 0.5 }, 'Оператор-01', 'БР'],
    ['ТОО «Икс-Эл-2»', await phoneOf(b.clientId), null, { dateTime: 46336.75 }, null, 'Оператор-02', 'БР'],
  ];
  const x = await preview([], authors(), xlsx({ sheets: [{ name: 'Записи', rows }] }));
  assert.equal(x.up.kind, 'xlsx');
  assert.equal(x.s.counts.byGroup.errors, 0, 'нет «Ошибок разбора»');
  assert.deepEqual(await actionsOf(x.up.importId), ['create', 'create']);
  const res = await applyOf(x);
  assert.equal(res.written.bookingsCreated, 2);
  assert.deepEqual((await bookingsOf(a.clientId)).map((r) => r.eventId), [w.events['twoEvents:12:00']]);
  assert.deepEqual((await bookingsOf(b.clientId)).map((r) => [r.eventId, r.bookedByUserId]), [[w.events['twoEvents:18:00'], w.staff.op2]]);
});

// ---------- мероприятие сегодня ----------

test('мероприятие сегодня: уже закончилось — «прошло», запись не создаётся; идущее и вечернее — создаются', async () => {
  // T0 = 2026-10-21 09:00 UTC; мероприятия сегодня по 180 мин в 05:00 (закончилось), 08:00 (идёт) и 20:00 (по UTC, как в мире тестов)
  const today = '2026-10-21';
  await mkEvent(db, w.spaceId, { date: today, time: '05:00' });
  const running = await mkEvent(db, w.spaceId, { date: today, time: '08:00' });
  const evening = await mkEvent(db, w.spaceId, { date: today, time: '20:00' });
  const early = await mkClient(db, w.spaceId, { name: 'ТОО «Рано-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const morning = await mkClient(db, w.spaceId, { name: 'ТОО «Утро-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const late = await mkClient(db, w.spaceId, { name: 'ТОО «Вечер-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const x = await preview([
    HEAD,
    line({ name: 'ТОО «Рано-1»', phone: await phoneOf(early.clientId), date: '21.10.2026', time: '05:00' }),
    line({ name: 'ТОО «Утро-1»', phone: await phoneOf(morning.clientId), date: '21.10.2026', time: '08:00' }),
    line({ name: 'ТОО «Вечер-1»', phone: await phoneOf(late.clientId), date: '21.10.2026', time: '20:00' }),
  ]);
  assert.deepEqual(await actionsOf(x.up.importId), ['past_event', 'create', 'create']);
  await applyOf(x);
  assert.equal((await bookingsOf(early.clientId)).length, 0, 'явку отметить некому — записи нет');
  assert.equal((await cardOf(early.cardId)).state, 'callback');
  assert.deepEqual((await bookingsOf(morning.clientId)).map((r) => r.eventId), [running]);
  assert.deepEqual((await bookingsOf(late.clientId)).map((r) => r.eventId), [evening]);
});

// ---------- ярлыки авторов ----------

test('ярлык оператора длиннее 200 символов: подсказка и карта — по обрезанному ярлыку, схема тела его принимает, импорт применяется', async () => {
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Длинный-Ярлык»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const long = `Оператор-01 ${'комментарий '.repeat(40)}`;
  const actor = await actorOf(w);
  const up = await upload(actor, [HEAD, line({ name: 'ТОО «Длинный-Ярлык»', phone: await phoneOf(c.clientId), op: long })], { now: t() });
  const details = await importApi.getImport(actor, up.importId, t());
  const label = details?.bookings?.hints[0]?.label ?? '';
  assert.ok(label.length > 0 && label.length <= imports.AUTHOR_LABEL_MAX, `длина ярлыка ${label.length}`);
  const map = { [label]: w.staff.op1 };
  assert.ok(PreviewBody.safeParse({ ownerMap: {}, authorMap: map }).success, 'тело с этим ярлыком проходит схему маршрута');
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: map }, t())) as BookingPreviewSummary;
  assert.deepEqual(s.blockers, []);
  const res = (await importApi.apply(actor, up.importId, { fingerprint: s.fingerprint, ownerMap: {}, authorMap: map }, t())) as BookingApplyResult;
  assert.equal(res.written.bookingsCreated, 1);
});

test('больше 200 разных авторов у строк create — блокер too_many_authors с текстом, а не отказ тела', async () => {
  const day = '2026-11-12';
  await mkEvent(db, w.spaceId, { date: day, capacity: 500 });
  const n = imports.AUTHOR_MAP_MAX + 1;
  const grid: string[][] = [HEAD];
  for (let i = 0; i < n; i++) {
    const name = `ТОО «Много-Авторов-${i}»`;
    const c = await mkClient(db, w.spaceId, { name, phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
    grid.push(line({ name, phone: await phoneOf(c.clientId), date: '12.11.2026', op: `Автор-${i}` }));
  }
  const x = await preview(grid, {});
  assert.equal(x.s.counts.byAction.create, n);
  assert.ok(x.s.blockers.includes('too_many_authors'), `блокеры: ${x.s.blockers.join(',')}`);
});
