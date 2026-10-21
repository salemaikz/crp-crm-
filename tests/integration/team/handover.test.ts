// B9a (docs/tasks-team-design.md §6.4, §10): отключение сотрудника с передачей дел — «срочно», получатель-отключающий,
// «некому принять», мастер (флаг), временные владельцы, повтор. Мир изоляции; только синтетика (+7 709 …).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { countOwnerlessWorkingCards } from '../../../src/server/domain/cards';
import { systemActor } from '../../../src/server/access/systemActor';
import { disableStaff, handoverPreview, purgeChangeSnapshots } from '../../../src/server/domain/team';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, setCard, viewerOf } from '../calls/world';

let db: TestDb;
let admin: Viewer;
const local = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:00`);

const owner = async (id: string) => (await db.sql<{ o: string | null; a: string | null; u: string; s: string; v: number }>`
  SELECT owner_user_id AS o, acting_user_id AS a, acting_until_day AS u, state AS s, version AS v FROM cards WHERE id = ${id}`)[0]!;

/** Чистое состояние: все активны, карточки A и B — «повтор» у своих владельцев, без задач/записей/отсутствий прошлых тестов. */
async function reset(): Promise<void> {
  process.env.FEATURE_BULK_TRANSFER = '1';
  await db.sql`UPDATE users SET status = 'active', disabled_at = NULL, is_admin = (id = ${U.admin}) WHERE id <> ${U.disabled}`;
  await db.sql`UPDATE memberships SET status = 'active', in_distribution = (role_key = 'operator') WHERE user_id <> ${U.disabled}`;
  await db.sql`DELETE FROM change_snapshots`;
  await db.sql`DELETE FROM assign_log`;
  await db.sql`DELETE FROM notifications`;
  await db.sql`DELETE FROM absences`;
  await db.sql`DELETE FROM audit_log WHERE action IN ('client.transfer', 'user.disable')`;
  await db.sql`DELETE FROM client_events WHERE kind IN ('card.transferred', 'card.acting', 'card.released')`;
  await db.sql`DELETE FROM bookings WHERE id LIKE 'bk-ho-%'`;
  await db.sql`DELETE FROM tasks WHERE id LIKE 'tk-ho-%'`;
  await db.sql`DELETE FROM deals WHERE id LIKE 'dl-ho-%'`;
  await db.sql`UPDATE cards SET owner_user_id = CASE WHEN client_id LIKE 'cl-a-%' THEN ${U.opA} ELSE ${U.opB} END, acting_user_id = NULL, acting_until_day = '',
                              state = 'retry', calls_total = 0, version = 0, hold_reason = '' WHERE id LIKE 'cd-a-%' OR id LIKE 'cd-b-%'`;
  await db.sql`UPDATE tasks SET assignee_user_id = CASE WHEN client_id LIKE 'cl-a-%' THEN ${U.opA} ELSE ${U.opB} END WHERE id IN ('tk-a-1', 'tk-b-1')`;
  admin = await viewerOf(U.admin);
}

before(async () => {
  db = await openCallsWorld();
});
after(async () => {
  delete process.env.FEATURE_BULK_TRANSFER;
  await closeCallsWorld(db);
});

/** Сценарий отключаемого оператора B. */
async function seedOperatorB(): Promise<void> {
  await setCard(db.sql, 'cd-b-2', { state: 'new' }); // нетронутая новая → пул
  await setCard(db.sql, 'cd-b-3', { state: 'new' });
  await db.sql`UPDATE cards SET calls_total = 2 WHERE id = 'cd-b-3'`; // новая со звонками → рабочая
  await setCard(db.sql, 'cd-b-4', { state: 'not_interested' }); // закрытая остаётся
  await setCard(db.sql, 'cd-b-5', { state: 'callback', owner: U.opA, acting: U.opB }); // B временный у A
  await db.sql`UPDATE cards SET acting_until_day = '2026-10-30' WHERE id = 'cd-b-5'`;
  await setCard(db.sql, 'cd-b-6', { acting: U.duty }); // у B временный duty
  await db.sql`UPDATE cards SET acting_until_day = '2026-10-31' WHERE id = 'cd-b-6'`;
  await db.sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, substitute_user_id, created_by, created_at)
               VALUES ('ab-ho-1', ${SPACE}, ${U.opB}, '2026-10-28', '2026-10-30', ${U.duty}, ${U.rop}, ${SEED_NOW})`;
  // задача на клиента без карточки B, будущая запись и сделка за B
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
               VALUES ('tk-ho-1', ${SPACE}, 'cl-a-20', 'other', 'manual', 'Прочее', ${U.opB}, ${SEED_NOW}),
                      ('tk-ho-2', ${SPACE}, 'cl-b-1', 'other', 'manual', 'Закрытая', ${U.opB}, ${SEED_NOW})`;
  await db.sql`UPDATE tasks SET status = 'done', done_at = ${SEED_NOW} WHERE id = 'tk-ho-2'`;
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time, starts_at, duration_min,
                                     booked_by_user_id, responsible_user_id, created_at, updated_at)
               VALUES ('bk-ho-1', ${SPACE}, 'individual', 'consult', 'rs-cons', 'cl-a-21', 'cd-a-21', '2026-10-30', '11:00', ${local('2026-10-30', '11:00')}, 60,
                       ${U.opB}, ${U.opB}, ${SEED_NOW}, ${SEED_NOW})`;
}

test('«срочно»: ни одной рабочей карточки без владельца; временные, задачи, записи — получателю; закрытые остаются; новая — в пул', async () => {
  await reset();
  await seedOperatorB();
  const pv = await handoverPreview(admin, U.opB);
  assert.deepEqual([pv.working, pv.untouched, pv.actingCards, pv.recipient?.userId], [97, 1, 1, U.rop]); // 100 − закрытая − нетронутая − 1 из B5 (передана A)… см. ниже

  const res = await disableStaff(admin, U.opB, { mode: 'urgent' });
  assert.deepEqual([res.handover.status, res.handover.releasedCards, res.handover.actingCards], ['done', 1, 1]);
  assert.equal(res.handover.movedCards, 97);

  // получатель — первый активный сотрудник резервной роли (администратор без роли в пространстве)
  assert.equal((await owner('cd-b-1')).o, U.rop);
  assert.equal((await owner('cd-b-3')).o, U.rop);
  assert.deepEqual(await owner('cd-b-2').then((c) => [c.o, c.s]), [null, 'new']);
  assert.equal((await owner('cd-b-4')).o, U.opB, 'закрытые остаются за отключённым');
  assert.deepEqual(await owner('cd-b-5').then((c) => [c.o, c.a, c.u]), [U.opA, U.rop, '2026-10-30']);
  assert.deepEqual(await owner('cd-b-6').then((c) => [c.o, c.a, c.u]), [U.rop, null, '']);
  const left = await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.opB} AND state IN ('new', 'retry', 'callback', 'agreed', 'client')`;
  assert.equal(left.length, 0, 'у отключённого нет рабочих карточек');
  assert.equal(await countOwnerlessWorkingCards(systemActor('invariants', SEED_NOW)), 0);

  // сделка B1 (открытая) и его задача — получателю; чужая задача на карточку без B — тоже; закрытая задача не тронута
  assert.equal((await db.sql<{ o: string }>`SELECT owner_user_id AS o FROM deals WHERE id = 'dl-b-1'`)[0]!.o, U.rop);
  assert.equal((await db.sql<{ a: string }>`SELECT assignee_user_id AS a FROM tasks WHERE id = 'tk-b-1'`)[0]!.a, U.rop);
  assert.equal((await db.sql<{ a: string }>`SELECT assignee_user_id AS a FROM tasks WHERE id = 'tk-ho-1'`)[0]!.a, U.rop);
  assert.equal((await db.sql<{ a: string }>`SELECT assignee_user_id AS a FROM tasks WHERE id = 'tk-ho-2'`)[0]!.a, U.opB);
  const bk = await db.sql<{ r: string; b: string }>`SELECT responsible_user_id AS r, booked_by_user_id AS b FROM bookings WHERE id = 'bk-ho-1'`;
  assert.deepEqual([bk[0]!.r, bk[0]!.b], [U.rop, U.opB]);
  // отсутствие отменено
  assert.notEqual((await db.sql<{ c: number | null }>`SELECT cancelled_at AS c FROM absences WHERE id = 'ab-ho-1'`)[0]!.c, null);

  // журнал: release, transfer (без расхода лимита), absence для замены временного
  const kinds = await db.sql<{ kind: string; n: number }>`SELECT kind, count(*)::int AS n FROM assign_log GROUP BY kind ORDER BY kind`;
  assert.deepEqual(kinds.map((k) => [k.kind, k.n]), [['absence', 1], ['release', 1], ['transfer', 97]]);
  assert.equal((await db.sql`SELECT 1 FROM assign_log WHERE counts_to_cap`).length, 0);
  // снимок = числу изменённых строк: 97 карточек + 2 задачи (tk-b-1; в tk-ho-1 клиент вне набора — не в снимке) + сделки
  const snaps = await db.sql<{ t: string; n: number }>`SELECT table_name AS t, count(*)::int AS n FROM change_snapshots GROUP BY table_name ORDER BY table_name`;
  assert.deepEqual(snaps.map((s) => [s.t, s.n]), [['cards', 97], ['deals', 1], ['tasks', 1]]);
  // уведомление получателю: только число; ссылка на разбор — по сущности
  const note = await db.sql<{ userId: string; params: { count: number }; entityType: string }>`SELECT user_id, params, entity_type FROM notifications WHERE kind = 'staff_disabled'`;
  assert.deepEqual(note.map((n) => [n.userId, n.params.count, n.entityType]), [[U.rop, 98, 'handover']]);
  const audit = await db.sql<{ meta: { movedCards: number; handover: string } }>`SELECT meta FROM audit_log WHERE action = 'user.disable'`;
  assert.deepEqual([audit[0]!.meta.movedCards, audit[0]!.meta.handover], [97, 'done']);
  // вход закрыт
  assert.equal((await db.sql<{ s: string }>`SELECT status AS s FROM users WHERE id = ${U.opB}`)[0]!.s, 'disabled');

  // повторное отключение ничего не двигает
  const again = await disableStaff(admin, U.opB, { mode: 'urgent' });
  assert.equal(again.alreadyDisabled, true);
  assert.equal((await db.sql`SELECT 1 FROM assign_log`).length, 99);
});

test('получатель — отключающий, если его роль ведёт карточки пространства', async () => {
  await reset();
  await db.sql`UPDATE users SET is_admin = TRUE WHERE id = ${U.rop}`; // РОП с правом администратора
  const ropAdmin = await viewerOf(U.rop);
  const res = await disableStaff(ropAdmin, U.opA, { mode: 'urgent' });
  assert.equal(res.handover.movedCards, 100);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.rop}`).length, 100);
  assert.deepEqual((await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'staff_disabled'`).map((n) => n.userId), [U.rop]);
});

test('некому принять: карточки остаются за отключённым, временные снимаются, новая уходит в пул, администратору тревога', async () => {
  await reset();
  await seedOperatorB();
  await db.sql`UPDATE memberships SET status = 'disabled' WHERE user_id = ${U.rop}`; // резервной роли некому принять
  const res = await disableStaff(admin, U.opB, { mode: 'urgent' });
  assert.equal(res.handover.status, 'no_recipient');
  assert.equal(res.handover.movedCards, 0);
  assert.equal((await owner('cd-b-1')).o, U.opB, 'остаётся за отключённым');
  assert.deepEqual(await owner('cd-b-2').then((c) => [c.o]), [null], 'новая в пул');
  assert.deepEqual(await owner('cd-b-5').then((c) => [c.o, c.a, c.u]), [U.opA, null, ''], 'временный снят');
  const note = await db.sql<{ userId: string; params: { count: number } }>`SELECT user_id, params FROM notifications ORDER BY kind`;
  assert.deepEqual(note.map((n) => n.userId), [U.admin]);
  // число = оставшиеся рабочие + временные карточки, каждая один раз (без двойного счёта временных)
  const left = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE owner_user_id = ${U.opB} AND state IN ('new','retry','callback','agreed','client') AND hold_reason <> 'merged'`)[0]!.n;
  assert.ok(left >= 97);
  assert.equal(note[0]!.params.count, left + res.handover.actingCards, 'без двойного счёта временных');
  assert.equal((await db.sql<{ a: string }>`SELECT assignee_user_id AS a FROM tasks WHERE id = 'tk-b-1'`)[0]!.a, U.opB, 'задачи остались');
  // ночная сверка найдёт такие карточки: рабочая без владельца здесь нет, но за отключённым они числятся
  assert.equal((await db.sql`SELECT 1 FROM change_snapshots`).length, 0);
});

test('мастер: одному получателю и «поровну» (флаг); без флага — 404 и сотрудник не отключён', async () => {
  await reset();
  await seedOperatorB();
  process.env.FEATURE_BULK_TRANSFER = '0';
  const off = await disableStaff(admin, U.opB, { mode: 'wizard', to: { userId: U.duty } }).then(() => null, (e: unknown) => e);
  assert.ok(off instanceof NotFoundError);
  assert.equal((await db.sql<{ s: string }>`SELECT status AS s FROM users WHERE id = ${U.opB}`)[0]!.s, 'active');
  // без `to` мастер = «срочно» и флага не требует
  process.env.FEATURE_BULK_TRANSFER = '1';

  const one = await disableStaff(admin, U.opB, { mode: 'wizard', to: { userId: U.duty } });
  assert.equal(one.handover.movedCards, 97);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.duty} AND state <> 'new'`).length >= 95, true);
  assert.equal((await owner('cd-b-1')).o, U.duty);
  // остальное (временный, оставшиеся задачи) — получателю «срочного» режима
  assert.equal((await owner('cd-b-5')).a, U.rop);
  assert.equal((await db.sql<{ a: string }>`SELECT assignee_user_id AS a FROM tasks WHERE id = 'tk-ho-1'`)[0]!.a, U.rop);

  await reset();
  await seedOperatorB();
  const even = await disableStaff(admin, U.opB, { mode: 'wizard', to: { even: [U.opA, U.duty] } });
  assert.equal(even.handover.movedCards, 97);
  const split = await db.sql<{ o: string; n: number }>`SELECT owner_user_id AS o, count(*)::int AS n FROM cards WHERE client_id LIKE 'cl-b-%' AND id <> 'cd-b-5' AND owner_user_id IN (${U.opA}, ${U.duty}) GROUP BY 1 ORDER BY 1`;
  assert.ok(split.length === 2 && Math.abs(split[0]!.n - split[1]!.n) <= 1, JSON.stringify(split));

  // получатель мастера обязан быть активным и вести карточки
  await reset();
  const bad = await disableStaff(admin, U.opB, { mode: 'wizard', to: { userId: U.director } }).then(() => null, (e: unknown) => e as { detail?: string });
  assert.equal((bad as { detail?: string }).detail, 'recipient');
  assert.equal((await db.sql<{ s: string }>`SELECT status AS s FROM users WHERE id = ${U.opB}`)[0]!.s, 'active', 'откат всей операции');
});

test('purge: снимки старше срока удаляются, свежие остаются', async () => {
  await reset();
  await db.sql`INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
               VALUES ('cs-old', 'op-old', 'bulk_transfer', 'cards', 'cd-a-1', 'cl-a-1', '{}', NULL, ${SEED_NOW - 31 * 86_400_000}),
                      ('cs-new', 'op-new', 'bulk_transfer', 'cards', 'cd-a-2', 'cl-a-2', '{}', NULL, ${SEED_NOW - 86_400_000})`;
  const n = await purgeChangeSnapshots(systemActor('purge', SEED_NOW), SEED_NOW - 30 * 86_400_000);
  assert.equal(n, 1);
  assert.deepEqual((await db.sql<{ id: string }>`SELECT id FROM change_snapshots`).map((r) => r.id), ['cs-new']);
});
