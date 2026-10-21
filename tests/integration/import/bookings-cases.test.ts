/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД и ответы читаются по путям */
// Профиль «Записи» (D-324), отдельные случаи на Postgres: права и флаг, клиент по ИИН-HMAC, чужое пространство,
// владелец карточки, тронутая и задержанная карточка, запись из мастера, устаревший предпросмотр, параллель.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ForbiddenError, NotFoundError } from '../../../src/server/access';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { bookingDeps, createBooking } from '../../../src/server/domain/booking';
import { importApi, ImportError, listProfiles, type BookingApplyResult, type BookingPreviewSummary } from '../../../src/server/domain/import';
import { iinHmac } from '../../../src/server/domain/import/platformGlue';
import { newId } from '../../../src/server/platform/db';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { DAYS, T0, actorOf, makeBookingsWorld, mkClient, mkEvent, spaceIdOf, upload, viewerOf, type BookingsWorld } from './bookingsWorld';

let db: TestDb;
let w: BookingsWorld;
const NOW = T0 + 10_000;
let tick = 0;
const t = () => NOW + 1000 * ++tick;

const HEAD = ['Наименование', 'Телефон', 'БИН', 'Дата', 'Время', 'Оператор', 'Мероприятие'];
let phoneSeq = 100;
const ph = () => `+7 709 ${++phoneSeq} 00 11`;
type Row = { name?: string; phone?: string; bin?: string; date?: string; time?: string; op?: string; type?: string };
const line = (r: Row): string[] => [r.name ?? '', r.phone ?? '', r.bin ?? '', r.date ?? '05.11.2026', r.time ?? '', r.op ?? 'Оператор-01', r.type ?? 'БР'];
const authors = () => ({ 'Оператор-01': w.staff.op1, 'Оператор-02': w.staff.op2 });

before(async () => {
  db = await createTestDb();
  w = await makeBookingsWorld(db);
});
after(async () => {
  resetAccessForTests();
  await db.close();
});

async function preview(rows: Row[], map: Record<string, string | null> = authors(), userId = w.staff.rop) {
  const actor = await actorOf(w, userId);
  const up = await upload(actor, [HEAD, ...rows.map(line)], { now: t() });
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: map }, t())) as BookingPreviewSummary;
  return { actor, up, s };
}
async function actionsOf(importId: string, userId = w.staff.rop): Promise<string[]> {
  const r = await importApi.listRows(await actorOf(w, userId), importId, { filter: 'all', offset: 0, limit: 200 }, t());
  return (r.rows as any[]).map((x) => x.action);
}
async function applyOf(x: Awaited<ReturnType<typeof preview>>, map: Record<string, string | null> = authors()): Promise<BookingApplyResult> {
  return (await importApi.apply(x.actor, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: map }, t())) as BookingApplyResult;
}
const bookingsOf = (clientId: string) => db.sql<any>`SELECT * FROM bookings WHERE client_id = ${clientId} ORDER BY created_at`;
const cardOf = async (cardId: string) => (await db.sql<any>`SELECT * FROM cards WHERE id = ${cardId}`)[0];

// ---------- права и флаг ----------

test('права: оператор и директор — отказ; без Viewer и чужое пространство — «нет такого»', async () => {
  const op = await actorOf(w, w.staff.op1);
  await assert.rejects(upload(op, [HEAD]), (e: unknown) => e instanceof ForbiddenError, 'оператор');
  const dir = await actorOf(w, w.staff.director);
  await assert.rejects(upload(dir, [HEAD]), (e: unknown) => e instanceof ForbiddenError, 'директор');
  const rop = await actorOf(w);
  const { viewer: _v, ...bare } = rop;
  void _v;
  await assert.rejects(upload(bare, [HEAD]), (e: unknown) => e instanceof NotFoundError, 'без Viewer');
  const x = await preview([{ name: 'ТОО «Права-1»', phone: ph() }]);
  await assert.rejects(importApi.preview(op, x.up.importId, { ownerMap: {}, authorMap: authors() }, t()), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(importApi.apply(dir, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: authors() }, t()), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(importApi.listRows(op, x.up.importId, { filter: 'all', offset: 0, limit: 10 }, t()), (e: unknown) => e instanceof ForbiddenError);

  // РОП другого пространства: загрузка «Записей» чужого пространства — то же, что несуществующая (D-017).
  // Пространство временное: у него нет ревизии настроек, а следующие тесты переписывают настройки установки.
  const otherSpace = newId();
  await db.sql`INSERT INTO spaces (id, key, created_at) VALUES (${otherSpace}, 'rights-other', ${T0})`;
  try {
    await strangerSeesNothing(otherSpace, x);
  } finally {
    await db.sql`DELETE FROM memberships WHERE space_id = ${otherSpace}`;
    await db.sql`DELETE FROM spaces WHERE id = ${otherSpace}`;
  }
});

async function strangerSeesNothing(otherSpace: string, x: Awaited<ReturnType<typeof preview>>): Promise<void> {
  const { mkUser } = await import('./bookingsWorld');
  const otherRop = await mkUser(db, otherSpace, 'rop', 'Руководитель Другой');
  const stranger = { userId: otherRop, spaceId: otherSpace, viewer: await viewerOf(otherRop) };
  const missing = newId();
  assert.equal(await importApi.getImport(stranger, x.up.importId, t()), null);
  assert.equal(await importApi.getImport(stranger, missing, t()), null);
  const sameAsMissing = async (call: (id: string) => Promise<unknown>) => {
    const errOf = async (id: string) => call(id).then(() => assert.fail('ждали отказ'), (e: unknown) => e);
    const [foreign, none] = [await errOf(x.up.importId), await errOf(missing)];
    assert.ok(foreign instanceof NotFoundError || (foreign instanceof ImportError && foreign.code === 'not_found'), String(foreign));
    assert.equal((foreign as Error).constructor, (none as Error).constructor);
    assert.deepEqual([(foreign as Error).message, (foreign as { code?: string }).code], [(none as Error).message, (none as { code?: string }).code]);
  };
  await sameAsMissing((id) => importApi.preview(stranger, id, { ownerMap: {}, authorMap: authors() }, t()));
  await sameAsMissing((id) => importApi.apply(stranger, id, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: authors() }, t()));
  await sameAsMissing((id) => importApi.listRows(stranger, id, { filter: 'all', offset: 0, limit: 10 }, t()));
  assert.equal((await db.sql<any>`SELECT status FROM imports WHERE id = ${x.up.importId}`)[0].status, 'preview', 'чужой РОП ничего не применил');
}

test('охват: роль с import.run без booking.create/card.assign на пространство не видит профиль и не применяет', async () => {
  // синтетическая роль: только import.run — как «помощник» без прав на записи (охват меньше пространства)
  const { installBookingsConfig } = await import('./bookingsWorld');
  await installBookingsConfig((d) => {
    d.global.roles.push({ key: 'importer', label: { ru: 'Помощник' }, readOnly: false, grants: [{ perm: 'import.run', scope: 'space' }, { perm: 'booking.create', scope: 'own' }], relations: [], fieldAccessDefault: 'edit', menu: [] });
  });
  const { mkUser } = await import('./bookingsWorld');
  const helper = await mkUser(db, w.spaceId, 'importer', 'Помощник Синтетик');
  const actor = await actorOf(w, helper);
  await assert.rejects(upload(actor, [HEAD]), (e: unknown) => e instanceof ForbiddenError);
  const profiles = await listProfiles(actor);
  assert.ok(profiles.length > 0 && profiles.every((p) => p.kind === 'clients'), 'профиль «Записи» скрыт');
  const rop = await actorOf(w);
  assert.ok((await listProfiles(rop)).some((p) => p.kind === 'bookings'));
});

test('флаг FEATURE_IMPORT_BOOKINGS выключен: профиль скрыт, загрузка — bad_profile, предпросмотр и применение — «нет такого»', async () => {
  const x = await preview([{ name: 'ТОО «Флаг-1»', phone: ph() }]);
  process.env.FEATURE_IMPORT_BOOKINGS = '0';
  try {
    const rop = await actorOf(w);
    assert.ok(!(await listProfiles(rop)).some((p) => p.kind === 'bookings'));
    await assert.rejects(upload(rop, [HEAD]), (e: unknown) => e instanceof ImportError && e.code === 'bad_profile');
    await assert.rejects(importApi.preview(rop, x.up.importId, { ownerMap: {}, authorMap: authors() }, t()), (e: unknown) => e instanceof NotFoundError);
    await assert.rejects(importApi.apply(rop, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: authors() }, t()), (e: unknown) => e instanceof NotFoundError);
    await assert.rejects(importApi.listRows(rop, x.up.importId, { filter: 'all', offset: 0, limit: 10 }, t()), (e: unknown) => e instanceof NotFoundError);
  } finally {
    process.env.FEATURE_IMPORT_BOOKINGS = '1';
  }
});

test('нет нужных колонок — header_not_found с подписями колонок профиля; профиль клиентов не принимает «Записи»', async () => {
  const rop = await actorOf(w);
  await assert.rejects(
    importApi.upload(rop, { profileKey: 'bookings_table', snapshotDay: '2026-10-20', fileName: 'x.csv', body: Buffer.from('Колонка;Другая\n1;2\n') }, t()),
    (e: unknown) => e instanceof ImportError && e.code === 'header_not_found' && (e.detail.missing ?? []).length > 0,
  );
  const x = await preview([{ name: 'ТОО «Вид-1»', phone: ph() }]);
  const { importService } = await import('../../../src/server/domain/import');
  await assert.rejects(importService.preview(rop, x.up.importId, { ownerMap: {} }, t()), (e: unknown) => e instanceof ImportError && e.code === 'bad_profile');
});

// ---------- клиент ----------

test('клиент по ИИН-HMAC: ИП найден, в import_rows и отчёте нет 12 цифр ИИН', async () => {
  const IIN = '990101300555';
  const c = await mkClient(db, w.spaceId, { name: 'ИП Тест-Предприниматель', phone: ph(), state: 'callback', ownerUserId: w.staff.op1, iinHmac: iinHmac(IIN) });
  const x = await preview([{ name: 'ИП Тест-Предприниматель', phone: '', bin: IIN }]);
  const rows = await db.sql<any>`SELECT parsed::text AS p FROM import_rows WHERE import_id = ${x.up.importId}`;
  assert.ok(!rows[0].p.includes(IIN), 'открытого ИИН нет в import_rows');
  assert.equal(x.s.counts.byAction.create, 1);
  const res = await applyOf(x);
  assert.equal(res.written.bookingsCreated, 1);
  assert.equal((await bookingsOf(c.clientId)).length, 1);
  const [rep] = await db.sql<any>`SELECT report::text AS r FROM imports WHERE id = ${x.up.importId}`;
  assert.ok(!rep.r.includes(IIN));
});

test('клиент только в другом пространстве или без карточки — «клиент не найден» (чужое = несуществующее)', async () => {
  const other = newId();
  await db.sql`INSERT INTO spaces (id, key, created_at) VALUES (${other}, 'other', ${T0})`;
  const p1 = ph();
  const p2 = ph();
  await mkClient(db, w.spaceId, { name: 'ТОО «Чужое-1»', phone: p1, state: 'callback', ownerUserId: null, spaceId: other });
  await mkClient(db, w.spaceId, { name: 'ТОО «Без-Карточки-1»', phone: p2, noCard: true });
  const x = await preview([
    { name: 'ТОО «Чужое-1»', phone: p1 },
    { name: 'ТОО «Без-Карточки-1»', phone: p2 },
  ]);
  assert.deepEqual(await actionsOf(x.up.importId), ['client_not_found', 'client_not_found']);
  assert.equal(x.s.counts.byAction.create, 0);
  const [n] = await db.sql<any>`SELECT count(*)::int AS n FROM bookings b JOIN clients c ON c.id = b.client_id WHERE c.name LIKE 'ТОО «Чужое%'`;
  assert.equal(n.n, 0);
});

// ---------- карточка ----------

test('карточка без владельца: автор — оператор раздачи → владелец = автор, выдача kind=import вне лимита, «Договорились»', async () => {
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Без-Хозяина-1»', phone: ph(), state: 'new', ownerUserId: null });
  const x = await preview([{ name: 'ТОО «Без-Хозяина-1»', phone: (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits }]);
  const row = (await importApi.listRows(x.actor, x.up.importId, { filter: 'create', offset: 0, limit: 10 }, t())).rows[0] as any;
  assert.deepEqual(row.flags, ['owner_from_author']);
  const res = await applyOf(x);
  assert.deepEqual([res.written.bookingsCreated, res.written.ownersAssigned, res.written.cardsAgreed], [1, 1, 1]);
  const card = await cardOf(c.cardId);
  assert.deepEqual([card.ownerUserId, card.state], [w.staff.op1, 'agreed']);
  const [log] = await db.sql<any>`SELECT kind, counts_to_cap, to_user_id, actor_id, run_id FROM assign_log WHERE card_id = ${c.cardId}`;
  assert.deepEqual([log.kind, log.countsToCap, log.toUserId, log.actorId, log.runId], ['import', false, w.staff.op1, w.staff.rop, x.up.importId]);
  const [b] = await bookingsOf(c.clientId);
  assert.equal(b.responsibleUserId, w.staff.op1, 'ответственный — новый владелец');
});

test('карточка без владельца, автор не участник раздачи: запись есть, карточка не меняется, строка на разбор', async () => {
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Без-Хозяина-2»', phone: ph(), state: 'new', ownerUserId: null });
  const phone = (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits;
  const x = await preview([{ name: 'ТОО «Без-Хозяина-2»', phone, op: 'Оператор-77' }], { ...authors(), 'Оператор-77': w.staff.rop });
  const review = await importApi.listRows(x.actor, x.up.importId, { filter: 'group_review', offset: 0, limit: 10 }, t());
  assert.equal(review.total, 1, 'строка на разбор до применения');
  const res = await applyOf(x, { ...authors(), 'Оператор-77': w.staff.rop });
  assert.deepEqual([res.written.bookingsCreated, res.written.cardsAgreed, res.written.ownersAssigned], [1, 0, 0]);
  const card = await cardOf(c.cardId);
  assert.deepEqual([card.ownerUserId, card.state, card.version], [null, 'new', 0]);
  assert.equal((await bookingsOf(c.clientId)).length, 1);
});

test('задержанная карточка (ИП до юриста): гость записан, карточка не тронута; тронутая в CRM — записи нет', async () => {
  const held = await mkClient(db, w.spaceId, { name: 'ИП Задержанный', phone: ph(), state: 'new', ownerUserId: null, holdReason: 'rule' });
  const touched = await mkClient(db, w.spaceId, { name: 'ТОО «Тронутая-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1, touchedInCrm: true });
  const phoneOf = async (id: string) => (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${id}`)[0].digits;
  const x = await preview([
    { name: 'ИП Задержанный', phone: await phoneOf(held.clientId) },
    { name: 'ТОО «Тронутая-1»', phone: await phoneOf(touched.clientId) },
  ]);
  assert.deepEqual(await actionsOf(x.up.importId), ['create', 'kept_in_crm']);
  await applyOf(x);
  assert.equal((await bookingsOf(held.clientId)).length, 1);
  assert.deepEqual([(await cardOf(held.cardId)).state, (await cardOf(held.cardId)).holdReason], ['new', 'rule']);
  assert.equal((await bookingsOf(touched.clientId)).length, 0);
  assert.equal((await cardOf(touched.cardId)).state, 'callback');
});

test('карточка уже «Договорились»: ещё одна запись без перехода', async () => {
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Уже-Договорились»', phone: ph(), state: 'agreed', ownerUserId: w.staff.op1 });
  const phone = (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits;
  const x = await preview([{ name: 'ТОО «Уже-Договорились»', phone }]);
  const res = await applyOf(x);
  assert.deepEqual([res.written.bookingsCreated, res.written.cardsAgreed], [1, 0]);
  assert.equal((await cardOf(c.cardId)).version, 0, 'карточка не менялась');
});

// ---------- запись из мастера ----------

test('запись из мастера на то же мероприятие — «дубль», на другое того же вида — «конфликт», перенос решает РОП', async () => {
  const mk = async (name: string) => {
    const c = await mkClient(db, w.spaceId, { name, phone: ph(), state: 'agreed', ownerUserId: w.staff.op1 });
    const phone = (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits;
    return { ...c, phone };
  };
  const same = await mk('ТОО «Мастер-Тот-Же»');
  const other = await mk('ТОО «Мастер-Другой»');
  const rop = await viewerOf(w.staff.rop);
  const deps = { ...bookingDeps(), now: () => T0 };
  await createBooking(deps, rop, { kind: 'group', requestId: newId(), clientId: same.clientId, eventId: w.events.ok!, contactId: null });
  await createBooking(deps, rop, { kind: 'group', requestId: newId(), clientId: other.clientId, eventId: w.events.other!, contactId: null });
  const x = await preview([
    { name: 'ТОО «Мастер-Тот-Же»', phone: same.phone, date: '05.11.2026' },
    { name: 'ТОО «Мастер-Другой»', phone: other.phone, date: '05.11.2026' },
  ]);
  assert.deepEqual(await actionsOf(x.up.importId), ['booking_exists', 'booking_conflict']);
  assert.equal(x.s.counts.byAction.create, 0);
  const before = (await bookingsOf(other.clientId)).length;
  assert.equal(before, 1, 'перенос импортом не делается');
});

test('устаревший предпросмотр: запись из мастера между предпросмотром и применением → 409 preview_stale, ни одной записи', async () => {
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const phone = (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits;
  const spare = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-2»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const sparePhone = (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${spare.clientId}`)[0].digits;
  const x = await preview([{ name: 'ТОО «Гонка-1»', phone }, { name: 'ТОО «Гонка-2»', phone: sparePhone }]);
  assert.equal(x.s.counts.byAction.create, 2);
  // мастер записывает того же клиента на другое мероприятие (после «Договорились» из карточки)
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${c.cardId}`;
  await createBooking({ ...bookingDeps(), now: () => T0 }, await viewerOf(w.staff.rop), { kind: 'group', requestId: newId(), clientId: c.clientId, eventId: w.events.other!, contactId: null });
  await assert.rejects(
    importApi.apply(x.actor, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: authors() }, t()),
    (e: unknown) => e instanceof ImportError && e.code === 'preview_stale' && !!e.detail.summary,
  );
  assert.equal((await bookingsOf(c.clientId)).length, 1, 'импорт ничего не записал');
  assert.equal((await bookingsOf(spare.clientId)).length, 0, 'вторая строка тоже не записана: откат целиком');
  assert.equal((await db.sql<any>`SELECT status FROM imports WHERE id = ${x.up.importId}`)[0].status, 'preview');
});

test('карта авторов: нерешённый ярлык — blocked, чужой сотрудник — bad_author, уволенный сотрудник допустим', async () => {
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Автор-1»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const phone = (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits;
  const x = await preview([{ name: 'ТОО «Автор-1»', phone, op: 'Бывший Сотрудник' }], {});
  assert.deepEqual(x.s.unmappedAuthors, ['Бывший Сотрудник']);
  assert.ok(x.s.blockers.includes('unmapped_authors'));
  await assert.rejects(
    importApi.apply(x.actor, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: {} }, t()),
    (e: unknown) => e instanceof ImportError && e.code === 'blocked' && (e.detail.blockers ?? []).includes('unmapped_authors'),
  );
  await assert.rejects(
    importApi.preview(x.actor, x.up.importId, { ownerMap: {}, authorMap: { 'Бывший Сотрудник': newId() } }, t()),
    (e: unknown) => e instanceof ImportError && e.code === 'bad_author',
  );
  const { mkUser } = await import('./bookingsWorld');
  const gone = await mkUser(db, w.spaceId, 'operator', 'Бывший Сотрудник', 'disabled');
  const map = { 'Бывший Сотрудник': gone };
  const s = (await importApi.preview(x.actor, x.up.importId, { ownerMap: {}, authorMap: map }, t())) as BookingPreviewSummary;
  assert.deepEqual(s.blockers, []);
  const res = (await importApi.apply(x.actor, x.up.importId, { fingerprint: s.fingerprint, ownerMap: {}, authorMap: map }, t())) as BookingApplyResult;
  assert.equal(res.written.bookingsCreated, 1);
  assert.equal((await bookingsOf(c.clientId))[0].bookedByUserId, gone, 'заслуга остаётся за уволенным');
  // подсказка автора по ФИО
  const details = await importApi.getImport(x.actor, x.up.importId, t());
  assert.equal(details?.bookings?.hints.find((h) => h.label === 'Бывший Сотрудник')?.by, 'name');
});

test('мероприятие без указания времени при двух в день — «неоднозначно»; время в строке выбирает', async () => {
  const phone1 = ph();
  const c = await mkClient(db, w.spaceId, { name: 'ТОО «Два-Мероприятия»', phone: phone1, state: 'callback', ownerUserId: w.staff.op1 });
  void c;
  const x = await preview([
    { name: 'ТОО «Два-Мероприятия»', phone: phone1, date: '10.11.2026' },
    { name: 'ТОО «Два-Мероприятия»', phone: phone1, date: '10.11.2026', time: '12:00' },
  ]);
  assert.deepEqual(await actionsOf(x.up.importId), ['event_ambiguous', 'create']);
  void DAYS;
  void mkEvent;
  void spaceIdOf;
});

// ---------- параллель ----------

test('параллель: два apply одного импорта — один busy; мастер записи по карточке строки не сцепляется с импортом', async () => {
  const clients = [] as { clientId: string; cardId: string; phone: string }[];
  for (let i = 0; i < 4; i++) {
    const c = await mkClient(db, w.spaceId, { name: `ТОО «Параллель-${i}»`, phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
    clients.push({ ...c, phone: (await db.sql<any>`SELECT digits FROM client_phones WHERE client_id = ${c.clientId}`)[0].digits });
  }
  const x = await preview(clients.map((c, i) => ({ name: `ТОО «Параллель-${i}»`, phone: c.phone })));
  assert.equal(x.s.counts.byAction.create, 4);
  const rop = await viewerOf(w.staff.rop);
  const wizard = async () => {
    // карточка 0 «Договорились» из мастера: ждёт блокировку импорта или становится причиной устаревшего предпросмотра
    await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${clients[0]!.cardId} AND state = 'callback'`;
    return createBooking({ ...bookingDeps(), now: () => T0 }, rop, { kind: 'group', requestId: newId(), clientId: clients[0]!.clientId, eventId: w.events.other!, contactId: null });
  };
  const body = { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: authors() };
  const results = await Promise.allSettled([
    importApi.apply(x.actor, x.up.importId, body, t()),
    importApi.apply(x.actor, x.up.importId, body, t()),
    wizard(),
  ]);
  const errs = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  // никакой взаимной блокировки: допустимы busy, устаревший предпросмотр и отказ мастера
  for (const e of errs) assert.ok(!(typeof e === 'object' && e && (e as { code?: string }).code === '40P01'), `взаимная блокировка: ${String(e)}`);
  const applied = results.slice(0, 2).filter((r) => r.status === 'fulfilled').length;
  assert.ok(applied <= 1, 'применил не больше одного');
  // у клиента 0 не больше одной активной записи этого вида
  const active = await db.sql<any>`SELECT count(*)::int AS n FROM bookings WHERE client_id = ${clients[0]!.clientId} AND status IN ('registered','confirmed')`;
  assert.ok(active[0].n <= 1);
});

// ---------- выгрузка ----------

test('выгрузка строк CSV: формулы обезврежены, в аудит — только код фильтра и число строк', async () => {
  const x = await preview([{ name: '=1+1', phone: ph() }, { name: '@ТОО «Формула»', phone: ph() }]);
  const out = await importApi.exportRowsCsv(x.actor, x.up.importId, 'all', t(), { bookings: ['row', 'name', 'phones', 'date', 'time', 'type', 'operator', 'action', 'groups', 'flags', 'issues'] });
  assert.equal(out.rows, 2);
  assert.ok(out.csv.startsWith('﻿row;name;'));
  assert.ok(out.csv.includes("'=1+1") && out.csv.includes("'@ТОО"), 'ячейки с формулами начинаются с апострофа');
  const [a] = await db.sql<any>`SELECT meta::text AS meta FROM audit_log WHERE action = 'import.export' AND entity_id = ${x.up.importId}`;
  assert.deepEqual(JSON.parse(a.meta), { importId: x.up.importId, filter: 'all', rows: 2 });
});
