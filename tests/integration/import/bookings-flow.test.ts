/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД и ответы читаются по путям */
// Импорт «Записи» на Postgres (D-324): таблица клиентов → таблица записей → записи с via='import', автор по карте,
// «Договорились», сделка, закрытая «Уточнить договорённость»; повтор, смена автора, ПДн в журналах.
// Данные синтетические (tests/fixtures/import/README.md, «Таблица записей»).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { importApi, ImportError, type BookingPreviewSummary, type BookingApplyResult } from '../../../src/server/domain/import';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { digitRunsExcept } from '../../helpers/piiDigits';
import { T0, actorOf, generate, loadClientsTable, makeBookingsWorld, snapshot, upload, type BookingsWorld } from './bookingsWorld';

let db: TestDb;
let w: BookingsWorld;
const gen = generate(3);
const m = gen.meta;
const NOW = T0 + 10_000;

const AUTHORS = () => ({ 'Оператор-01': w.staff.op1, 'Оператор-02': w.staff.op2, 'Оператор-03': w.staff.rop, 'Посторонний-99': null });

before(async () => {
  db = await createTestDb();
  w = await makeBookingsWorld(db, { fullCapacity: 3 });
  await loadClientsTable(w, gen.clientsGrid);
});
after(async () => {
  resetAccessForTests();
  await db.close();
});

async function rowsOf(importId: string, filter: string, offset = 0): Promise<any[]> {
  const actor = await actorOf(w);
  const r = await importApi.listRows(actor, importId, { filter: filter as never, offset, limit: 200 }, NOW);
  return r.rows as any[];
}

let firstId = '';
let firstSummary: BookingPreviewSummary;

let callbackBefore = 0;
test('исходное состояние: карточки «Подтвержден» в «Перезвон», у каждой задача «Уточнить договорённость»', async () => {
  const [r] = await db.sql<any>`SELECT count(*) FILTER (WHERE state = 'callback')::int AS callback, count(*)::int AS cards FROM cards`;
  assert.ok(r.callback >= 20, `callback: ${r.callback}`);
  callbackBefore = r.callback;
  const [t] = await db.sql<any>`SELECT count(*)::int AS n FROM tasks WHERE source = 'clarify_import' AND status = 'open'`;
  assert.equal(t.n, r.callback);
});

test('загрузка: 7 колонок по заголовкам, ИП без открытого ИИН, в отчёте нет номеров и названий', async () => {
  const actor = await actorOf(w);
  const up = await upload(actor, gen.bookingsGrid);
  firstId = up.importId;
  assert.equal(up.rows, gen.bookingsGrid.length - 1);
  const [{ n }] = await db.sql<any>`SELECT count(*)::int AS n FROM import_rows WHERE import_id = ${firstId}`;
  assert.equal(n, up.rows);
  const [imp] = await db.sql<any>`SELECT report::text AS report FROM imports WHERE id = ${firstId}`;
  assert.deepEqual(digitRunsExcept(imp.report, [firstId]), [], 'в отчёте нет номеров');
  assert.doesNotMatch(imp.report, /ТОО|Клиент-|Оператор-/, 'в отчёте нет названий');
  const details = await importApi.getImport(actor, firstId, NOW);
  assert.equal(details?.kind, 'bookings');
  const labels = details!.bookings!.hints.map((h) => h.label).sort();
  assert.deepEqual(labels, ['Оператор-01', 'Оператор-02', 'Оператор-03', 'Посторонний-99']);
});

test('предпросмотр: действия по строкам таблицы, места, автор — блокер до решения РОП', async () => {
  const actor = await actorOf(w);
  const blocked = (await importApi.preview(actor, firstId, { ownerMap: {} }, NOW)) as BookingPreviewSummary;
  assert.ok(blocked.blockers.includes('unmapped_authors'), 'ярлыки без решения РОП — блокер');
  assert.deepEqual([...blocked.unmappedAuthors].sort(), ['Оператор-01', 'Оператор-02', 'Оператор-03', 'Посторонний-99']);

  firstSummary = (await importApi.preview(actor, firstId, { ownerMap: {}, authorMap: AUTHORS() }, NOW)) as BookingPreviewSummary;
  assert.deepEqual(firstSummary.blockers, []);
  const by = (rows: number[], action: string) => rows.map((r) => [r, action]);
  const all = [
    ...by(m.notFoundRows, 'client_not_found'),
    ...by(m.sharedAmbiguousRows, 'client_ambiguous'),
    ...by(m.noEventRows, 'no_event'),
    ...by(m.cancelledRows, 'event_cancelled'),
    ...by(m.pastRows, 'past_event'),
    ...by(m.duplicateRows, 'duplicate_in_file'),
    ...by(m.conflictRows, 'booking_conflict'),
    ...by(m.fullRows, 'event_full'),
    ...by(m.closedRows, 'state_conflict'),
    ...by(m.badDateRows, 'invalid'),
    ...by(m.badTimeRows, 'invalid'),
    ...by(m.unknownTypeRows, 'invalid'),
    ...by(m.individualRows, 'unsupported_type'),
    ...by(m.sharedByNameRows, 'create'),
    ...by(m.heldRows, 'create'),
    ...by(m.noOperatorRows, 'create'),
    ...by(m.unknownOperatorRows, 'create'),
    ...by(m.secondEventRows, 'create'),
    ...by(m.withBinRows, 'create'),
  ];
  const rows = await rowsOf(firstId, 'all');
  const actionOf = new Map(rows.map((r) => [r.rowNo, r.action]));
  for (const [row, action] of all) assert.equal(actionOf.get(row as number), action, `строка ${row}`);
  // обычные клиенты и первая из двух строк «Дубль»/«Конфликт» — создаются
  const creates = rows.filter((r) => r.action === 'create').length;
  assert.equal(firstSummary.counts.byAction.create, creates);
  assert.equal(creates, 22);
  // 22 записи, из них 21 с переходом в «Договорились» (карточка ИП задержана до юриста: запись есть, карточка не тронута)
  assert.equal(firstSummary.willAgree, 21);
  assert.equal(firstSummary.clarifyToClose, 21);
  assert.equal(firstSummary.counts.byFlag.card_held, 1);
  assert.equal(firstSummary.counts.byFlag.author_unknown, 2);
  // по мероприятиям: места считаются по порядку файла, полное мероприятие — ровно вместимость
  const full = firstSummary.byEvent.find((e) => e.eventId === w.events.full);
  assert.deepEqual([full?.create, full?.capacity], [3, 3]);
  assert.ok(firstSummary.byEvent.every((e) => e.typeLabel === 'Бизнес-разбор'), 'подпись вида — из настроек');
  // группы отчёта
  assert.equal(firstSummary.counts.byGroup.client_not_found, 2);
  assert.ok(firstSummary.counts.byGroup.no_event >= 6);
  assert.equal((await rowsOf(firstId, 'group_errors')).length, 3);
});

test('применение: записи с via=import и автором по карте, «Договорились», сделка, задачи закрыты, звонок без сотрудника', async () => {
  const actor = await actorOf(w);
  const before = await snapshot(db);
  // отпечаток от другой карты авторов не подходит
  await assert.rejects(
    importApi.apply(actor, firstId, { fingerprint: firstSummary.fingerprint, ownerMap: {}, authorMap: { ...AUTHORS(), 'Оператор-01': w.staff.op2 } }, NOW + 1000),
    (e: unknown) => e instanceof ImportError && e.code === 'preview_stale',
  );
  assert.deepEqual(await snapshot(db), before, 'неудачное применение ничего не записало');

  const res = (await importApi.apply(actor, firstId, { fingerprint: firstSummary.fingerprint, ownerMap: {}, authorMap: AUTHORS() }, NOW + 2000)) as BookingApplyResult;
  assert.equal(res.kind, 'bookings');
  assert.equal(res.alreadyApplied, false);
  assert.deepEqual(
    [res.written.bookingsCreated, res.written.cardsAgreed, res.written.ownersAssigned, res.written.authorChanged, res.written.clarifyClosed],
    [22, 21, 0, 0, 21],
  );

  const b = await db.sql<any>`SELECT * FROM bookings WHERE via = 'import'`;
  assert.equal(b.length, 22);
  assert.ok(b.every((x: any) => x.status === 'registered' && /^bk:[0-9a-f]{64}$/.test(x.importKey)));
  const byAuthor = (id: string | null) => b.filter((x: any) => x.bookedByUserId === id).length;
  assert.ok(byAuthor(w.staff.op1) > 0 && byAuthor(w.staff.op2) > 0, 'авторы по карте');
  assert.equal(byAuthor(null), 2, 'без оператора и «Посторонний» — автор неизвестен');

  // карточки: 21 в «Договорились», задержанная не тронута
  const [c] = await db.sql<any>`SELECT count(*) FILTER (WHERE state = 'agreed')::int AS agreed, count(*) FILTER (WHERE state = 'callback')::int AS callback FROM cards`;
  assert.equal(c.agreed, 21);
  assert.equal(c.callback, callbackBefore - 21, 'карточки без найденной записи остались у владельца');
  const [t] = await db.sql<any>`SELECT count(*) FILTER (WHERE status = 'open')::int AS open FROM tasks WHERE source = 'clarify_import'`;
  assert.equal(t.open, callbackBefore - 21, 'задачи «Уточнить договорённость» закрылись только у тех, кому нашлась запись');
  // сделка на этапе «Записан» у каждой записи; импортный звонок без сотрудника
  const deals = await db.sql<any>`SELECT d.id, d.stage_key FROM deals d WHERE d.id IN (SELECT deal_id FROM bookings WHERE via = 'import')`;
  assert.equal(deals.length, 22, 'сделка у каждой записи; одна сделка на карточку');
  const stages = new Set(deals.map((d: any) => d.stageKey));
  assert.equal(stages.size, 1);
  const [call] = await db.sql<any>`SELECT count(*)::int AS n FROM calls WHERE via = 'import' AND user_id IS NULL AND outcome_kind = 'agreed' AND received_at = ${NOW + 2000}`;
  assert.equal(call.n, 21);
  // история записи: created + import с ключом состояния
  const [h] = await db.sql<any>`SELECT count(*)::int AS n FROM booking_history WHERE action = 'import' AND meta ->> 'stateKey' IS NOT NULL`;
  assert.equal(h.n, 22);
  // карточка тронутой не помечена
  const [touched] = await db.sql<any>`SELECT count(*)::int AS n FROM cards WHERE touched_in_crm`;
  assert.equal(touched.n, 0);
});

test('места: на полном мероприятии занято ровно вместимость, лишние строки не созданы', async () => {
  const [r] = await db.sql<any>`SELECT count(*)::int AS n FROM bookings WHERE event_id = ${w.events.full}`;
  assert.equal(r.n, 3);
});

test('ПДн: в report, booking_history.meta, client_events.data и audit_log.meta нет длинных серий цифр и названий', async () => {
  const [imp] = await db.sql<any>`SELECT report::text AS report FROM imports WHERE id = ${firstId}`;
  const history = await db.sql<any>`SELECT meta::text AS meta FROM booking_history WHERE action = 'import'`;
  const feed = await db.sql<any>`SELECT data::text AS data FROM client_events WHERE kind = 'import.row' AND ref_id = ${firstId}`;
  const audit = await db.sql<any>`SELECT meta::text AS meta FROM audit_log WHERE entity = 'import' AND entity_id = ${firstId}`;
  assert.ok(feed.length >= 22);
  const text = [imp.report, ...history.map((x: any) => x.meta), ...feed.map((x: any) => x.data), ...audit.map((x: any) => x.meta)].join('\n').replace(/"(at|appliedAt|durationMs)":\s*\d+/g, '"$1":0');
  // keys (rowKey/stateKey) — хэши из букв и цифр; цифровая серия ≥ 10 в них допустима только как часть hex, поэтому ищем в «чистых» числовых токенах
  const tokens = text.match(/(?<![0-9a-f:-])\d{10,}(?![0-9a-f])/g) ?? [];
  assert.deepEqual(tokens, [], 'нет номеров и БИН');
  assert.doesNotMatch(text, /ТОО|Клиент-|Оператор-|Посторонний/, 'нет названий и ярлыков');
});

test('повтор: тот же файл ещё раз — пропуск всех созданных, блокер «нечего применять», ни одной новой строки в БД', async () => {
  const actor = await actorOf(w);
  const before = await snapshot(db);
  const up = await upload(actor, gen.bookingsGrid, { now: NOW + 3000 });
  assert.ok(up.sameFileApplied, 'тот же файл уже применялся');
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: AUTHORS() }, NOW + 4000)) as BookingPreviewSummary;
  assert.equal(s.counts.byAction.skip_same, 22, 'все созданные записи — пропуск');
  assert.equal(s.counts.byAction.duplicate_in_file, 1, 'вторая такая же строка — повтор строки, а не смена автора');
  assert.equal(s.counts.byAction.create, 0);
  assert.deepEqual(s.blockers, ['nothing_to_apply']);
  await assert.rejects(
    importApi.apply(actor, up.importId, { fingerprint: s.fingerprint, ownerMap: {}, authorMap: AUTHORS() }, NOW + 5000),
    (e: unknown) => e instanceof ImportError && e.code === 'blocked' && (e.detail.blockers ?? []).includes('nothing_to_apply'),
  );
  assert.deepEqual(await snapshot(db), before, 'повтор ничего не записал');
  // повтор apply того же импорта — прежний итог
  const again = (await importApi.apply(actor, firstId, { fingerprint: firstSummary.fingerprint, ownerMap: {}, authorMap: AUTHORS() }, NOW + 6000)) as BookingApplyResult;
  assert.equal(again.alreadyApplied, true);
  assert.equal(again.written.bookingsCreated, 22);
  assert.deepEqual(await snapshot(db), before);
});

test('смена оператора в таблице: «на разбор», запись не меняется; повтор той же загрузки — пропуск', async () => {
  const actor = await actorOf(w);
  const changed = gen.bookingsGrid.map((r) => [...r]);
  const rowNo = 2; // первый обычный клиент, оператор по кругу — Оператор-01
  assert.equal(changed[rowNo - 1]![5], 'Оператор-01');
  changed[rowNo - 1]![5] = 'Оператор-02';
  const [bookingBefore] = await db.sql<any>`SELECT id, booked_by_user_id, version FROM bookings WHERE via = 'import' AND booked_by_user_id = ${w.staff.op1} ORDER BY created_at, id LIMIT 1`;
  const before = await snapshot(db);

  const up = await upload(actor, changed, { now: NOW + 7000 });
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: AUTHORS() }, NOW + 8000)) as BookingPreviewSummary;
  assert.equal(s.counts.byAction.changed_in_file, 1);
  assert.equal(s.counts.byAction.skip_same, 21);
  assert.deepEqual(s.blockers, []);
  const review = await rowsOf(up.importId, 'group_review');
  assert.ok(review.some((r) => r.rowNo === rowNo && r.action === 'changed_in_file'), 'строка на разбор');

  const res = (await importApi.apply(actor, up.importId, { fingerprint: s.fingerprint, ownerMap: {}, authorMap: AUTHORS() }, NOW + 9000)) as BookingApplyResult;
  assert.deepEqual([res.written.bookingsCreated, res.written.authorChanged], [0, 1]);
  const after = await snapshot(db);
  assert.equal(after.bookings, before.bookings);
  assert.equal(after.bversions, before.bversions, 'запись не менялась');
  assert.equal(after.history, (before.history ?? 0) + 1, 'только одна строка истории с новым ключом состояния');
  const [same] = await db.sql<any>`SELECT booked_by_user_id FROM bookings WHERE id = ${bookingBefore.id}`;
  assert.equal(same.bookedByUserId, bookingBefore.bookedByUserId, 'заслуга после загрузки не меняется (D-042)');

  // та же загрузка ещё раз: ключ состояния уже записан → пропуск
  const up2 = await upload(actor, changed, { now: NOW + 10_000 });
  const s2 = (await importApi.preview(actor, up2.importId, { ownerMap: {}, authorMap: AUTHORS() }, NOW + 11_000)) as BookingPreviewSummary;
  assert.equal(s2.counts.byAction.changed_in_file, 0);
  assert.equal(s2.counts.byAction.skip_same, 22);
});

test('новые строки дописаны в таблицу: создаётся только они', async () => {
  const actor = await actorOf(w);
  const extra = [...gen.bookingsGrid.map((r) => [...r])];
  // клиент с готовой карточкой «Договорились»: ещё одна запись на другое мероприятие того же дня недоступна — берём новый день
  const { mkClient } = await import('./bookingsWorld');
  await mkClient(db, w.spaceId, { name: 'ТОО «Дописанный»', phone: '+7 709 777 00 01', state: 'callback', ownerUserId: w.staff.op1 });
  extra.push(['ТОО «Дописанный»', '+7 709 777 00 01', '', '05.11.2026', '', 'Оператор-01', 'БР']);
  const up = await upload(actor, extra, { now: NOW + 12_000 });
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: AUTHORS() }, NOW + 13_000)) as BookingPreviewSummary;
  assert.equal(s.counts.byAction.create, 1);
  // файл исходный, а оператор в строке 2 уже менялся (прошлый тест): это «сменился автор», не новая запись
  assert.equal(s.counts.byAction.skip_same, 21);
  assert.equal(s.counts.byAction.changed_in_file, 1);
  const res = (await importApi.apply(actor, up.importId, { fingerprint: s.fingerprint, ownerMap: {}, authorMap: AUTHORS() }, NOW + 14_000)) as BookingApplyResult;
  assert.deepEqual([res.written.bookingsCreated, res.written.cardsAgreed, res.written.authorChanged], [1, 1, 1]);
});
