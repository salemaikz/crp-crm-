// C6b (docs/tasks-team-design.md §2, §10): «Отсутствует» с временным владельцем и «поровну», задача `absence`,
// отмена, пересечение, «Пауза» РОП, раздел «Без владельца (не новые)». Календарь мира: 29.10 — праздник,
// 31.10 — суббота, следующий рабочий после пятницы 30.10 — понедельник 02.11. Только синтетика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenError, NotFoundError } from '../../../src/server/access';
import { systemActor } from '../../../src/server/access/systemActor';
import type { Viewer } from '../../../src/server/access/types';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import { absenceJob } from '../../../src/server/domain/distribution';
import { cancelAbsence, createAbsence, listAbsences, runAbsences } from '../../../src/server/domain/distribution/absence';
import { overrideDistributionDepsForTests } from '../../../src/server/domain/distribution/deps';
import { DistributionDomainError } from '../../../src/server/domain/distribution/errors';
import { assignOwnerless, listOwnerless } from '../../../src/server/domain/distribution/ownerless';
import { setPause } from '../../../src/server/domain/distribution/participants';
import { getPool } from '../../../src/server/domain/distribution/pool';
import { loadDistributionConfig } from '../../../src/server/domain/distribution/settings';
import { runTick } from '../../../src/server/domain/distribution/tick';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U } from '../../isolation/harness/seed';
import { DAY, HOUR, callsDeps, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from '../calls/world';
import { seedPool } from './helpers';

let db: TestDb;
let rop: Viewer;
let opA: Viewer;
let opB: Viewer;
const clock = { now: SEED_NOW };
const uuid = (): string => globalThis.crypto.randomUUID();
const sys = (now: number) => systemActor('absence@sales', now);
/** Местное время Алматы (UTC+5) → epoch-мс. */
const local = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:00`);

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DistributionDomainError);

const cardState = async (id: string) =>
  (await db.sql<{ owner: string | null; acting: string | null; until: string; state: string; version: number }>`
    SELECT owner_user_id AS owner, acting_user_id AS acting, acting_until_day AS until, state, version FROM cards WHERE id = ${id}`)[0]!;
const logOf = (kind: string, card?: string) =>
  db.sql<{ cardId: string; fromUserId: string | null; toUserId: string | null; countsToCap: boolean; runId: string }>`
    SELECT card_id, from_user_id, to_user_id, counts_to_cap, run_id FROM assign_log
     WHERE kind = ${kind} AND (${card ?? null}::text IS NULL OR card_id = ${card ?? null}) ORDER BY card_id, created_at`;

async function booking(id: string, card: string, client: string, date: string): Promise<void> {
  await db.sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time, starts_at,
                          duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
    VALUES (${id}, ${SPACE}, 'individual', 'consult', 'rs-cons', ${client}, ${card}, ${date}, '11:00', ${local(date, '11:00')}, 60,
            ${U.opA}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
}

/** Чистое состояние между тестами: отсутствия, временные, паузы, карточки A возвращены в «повтор без срока». */
async function reset(): Promise<void> {
  clock.now = SEED_NOW;
  await db.sql`DELETE FROM absences`;
  await db.sql`DELETE FROM bookings WHERE id LIKE 'bk-ab-%'`;
  await db.sql`DELETE FROM assign_log`;
  await db.sql`DELETE FROM notifications WHERE kind LIKE 'absence_%'`;
  await db.sql`DELETE FROM audit_log WHERE action LIKE 'distribution.%'`;
  await db.sql`UPDATE memberships SET paused_on = '' WHERE role_key = 'operator'`;
  await db.sql`UPDATE cards SET owner_user_id = ${U.opA}, acting_user_id = NULL, acting_until_day = '', state = 'retry', next_call_at = NULL, calls_total = 0, version = 0 WHERE id LIKE 'cd-a-%'`;
}

/** Сценарий владельца A: что берём под отсутствие 28–30.10, что нет. */
async function seedScenario(): Promise<void> {
  await setCard(db.sql, 'cd-a-1', { state: 'callback', nextCallAt: local('2026-10-29', '12:00') });
  await setCard(db.sql, 'cd-a-2', { state: 'retry', nextCallAt: SEED_NOW - HOUR });
  await setCard(db.sql, 'cd-a-3', { state: 'callback', nextCallAt: local('2026-11-05', '12:00') });
  await setCard(db.sql, 'cd-a-4', { state: 'agreed' });
  await booking('bk-ab-4', 'cd-a-4', 'cl-a-4', '2026-11-02');
  await setCard(db.sql, 'cd-a-5', { state: 'agreed' });
  await booking('bk-ab-5', 'cd-a-5', 'cl-a-5', '2026-11-03');
  await setCard(db.sql, 'cd-a-6', { state: 'new' });
  await setCard(db.sql, 'cd-a-7', { state: 'new' });
  await db.sql`UPDATE cards SET calls_total = 3 WHERE id = 'cd-a-7'`;
  await setCard(db.sql, 'cd-a-8', { state: 'written_off' });
}

before(async () => {
  db = await openCallsWorld();
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  overrideDistributionDepsForTests({ config: loadDistributionConfig, now: () => clock.now });
});
after(async () => {
  overrideDistributionDepsForTests(null);
  await closeCallsWorld(db);
});

test('создание: перезвон и просроченный, гость на следующий рабочий день — временному; новая — в пул; поздние и закрытые не тронуты', async () => {
  await reset();
  await seedScenario();
  const r = await createAbsence(rop, { opId: uuid(), userId: U.opA, fromDay: '2026-10-28', toDay: '2026-10-30', substituteUserId: U.opB });
  assert.deepEqual(r.applied, { acting: 3, released: 1 });
  for (const id of ['cd-a-1', 'cd-a-2', 'cd-a-4']) {
    const c = await cardState(id);
    assert.deepEqual([c.owner, c.acting, c.until, c.version], [U.opA, U.opB, '2026-10-30', 1], id);
  }
  for (const id of ['cd-a-3', 'cd-a-5', 'cd-a-7', 'cd-a-8']) {
    const c = await cardState(id);
    assert.deepEqual([c.acting, c.version], [null, 0], `${id} не тронута`);
  }
  assert.deepEqual(await cardState('cd-a-6').then((c) => [c.owner, c.state]), [null, 'new']);
  assert.deepEqual((await logOf('release')).map((l) => [l.cardId, l.fromUserId, l.toUserId]), [['cd-a-6', U.opA, null]]);
  const abs = await logOf('absence');
  assert.deepEqual(abs.map((l) => [l.cardId, l.fromUserId, l.toUserId, l.countsToCap]), [
    ['cd-a-1', U.opA, U.opB, false],
    ['cd-a-2', U.opA, U.opB, false],
    ['cd-a-4', U.opA, U.opB, false],
  ]);
  assert.ok(abs.every((l) => l.runId === r.id), 'run_id = id отсутствия');
  const note = await db.sql<{ userId: string; params: { count: number } }>`SELECT user_id, params FROM notifications WHERE kind = 'absence_acting'`;
  assert.deepEqual(note.map((n) => [n.userId, n.params.count]), [[U.opB, 3]]);
  const feed = await db.sql<{ data: { actingUserId: string; untilDay: string } }>`SELECT data FROM client_events WHERE kind = 'card.acting' AND client_id = 'cl-a-1'`;
  assert.deepEqual(feed.map((f) => f.data), [{ actingUserId: U.opB, untilDay: '2026-10-30' }]);
  const audit = await db.sql<{ meta: { even: boolean } }>`SELECT meta FROM audit_log WHERE action = 'distribution.absence'`;
  assert.deepEqual(audit.map((a) => a.meta.even), [false]);
});

test('повтор opId — прежнее отсутствие без повторного применения; повтор задачи absence ничего не меняет', async () => {
  const opId = (await db.sql<{ id: string }>`SELECT id FROM absences`)[0]!.id;
  const before = await logOf('absence');
  const again = await createAbsence(rop, { opId, userId: U.opA, fromDay: '2026-10-28', toDay: '2026-10-30', substituteUserId: U.opB });
  assert.deepEqual([again.replayed, again.applied], [true, { acting: 0, released: 0 }]);
  const rep = await runAbsences(sys(clock.now), { spaceId: SPACE, runId: uuid(), now: clock.now });
  assert.deepEqual(rep, { ended: 0, released: 0, acting: 0 });
  assert.equal((await logOf('absence')).length, before.length);
  assert.equal((await cardState('cd-a-1')).version, 1);
  assert.equal((await listAbsences(rop)).length, 1);
});

test('пересечение дат — overlap; заместитель в отсутствии — substitute_absent; даты — dates', async () => {
  const dup = await failure(createAbsence(rop, { opId: uuid(), userId: U.opA, fromDay: '2026-10-30', toDay: '2026-11-02', substituteUserId: U.opB }));
  assert.deepEqual([dup?.code, dup?.status], ['overlap', 409]);
  await createAbsence(rop, { opId: uuid(), userId: U.opB, fromDay: '2026-11-04', toDay: '2026-11-05', substituteUserId: U.duty });
  const subAbsent = await failure(createAbsence(rop, { opId: uuid(), userId: U.duty, fromDay: '2026-11-04', toDay: '2026-11-06', substituteUserId: U.opB }));
  assert.equal(subAbsent?.code, 'substitute_absent');
  for (const [from, to] of [['2026-10-27', '2026-10-27'], ['2026-11-06', '2026-11-05'], ['2026-11-10', '2027-02-01'], ['2026-13-01', '2026-13-02']]) {
    const e = await failure(createAbsence(rop, { opId: uuid(), userId: U.duty, fromDay: from!, toDay: to!, substituteUserId: U.opB }));
    assert.deepEqual([e?.code, e?.status], ['dates', 400], `${from}…${to}`);
  }
  const self = await failure(createAbsence(rop, { opId: uuid(), userId: U.duty, fromDay: '2026-11-10', toDay: '2026-11-11', substituteUserId: U.duty }));
  assert.equal(self?.code, 'not_participant');
  await assert.rejects(createAbsence(rop, { opId: uuid(), userId: 'u-nobody', fromDay: '2026-11-10', toDay: '2026-11-11', substituteUserId: null }), NotFoundError);
});

test('итог временного владельца по замещаемой карточке применяется', async () => {
  const deps = callsDeps(clock);
  clock.now = SEED_NOW;
  const r = await submitOutcome(deps, opB, outcomeReq({ cardId: 'cd-a-2', occurredAt: SEED_NOW - 60_000 }));
  assert.equal(r.status, 'applied');
  assert.equal((await cardState('cd-a-2')).acting, U.opB);
});

test('задача absence: срок отсутствия попал позже — подхватывает; 31.10 07:30 временные сняты, журнал к владельцу', async () => {
  await setCard(db.sql, 'cd-a-9', { state: 'callback', nextCallAt: local('2026-10-30', '10:00') });
  clock.now = local('2026-10-29', '07:30');
  const first = await runAbsences(sys(clock.now), { spaceId: SPACE, runId: uuid(), now: clock.now });
  assert.deepEqual([first.ended, first.acting], [0, 1]);
  assert.equal((await cardState('cd-a-9')).acting, U.opB);

  clock.now = local('2026-10-31', '07:30');
  const last = await runAbsences(sys(clock.now), { spaceId: SPACE, runId: uuid(), now: clock.now });
  assert.equal(last.ended, 4);
  for (const id of ['cd-a-1', 'cd-a-2', 'cd-a-4', 'cd-a-9']) {
    const c = await cardState(id);
    assert.deepEqual([c.owner, c.acting, c.until], [U.opA, null, ''], id);
  }
  const back = (await logOf('absence')).filter((l) => l.fromUserId === U.opB && l.toUserId === U.opA && l.cardId === 'cd-a-1');
  assert.equal(back.length, 1, 'снятие записано от временного к владельцу (D-175)');
  const feed = await db.sql<{ data: { actingUserId: string | null } }>`SELECT data FROM client_events WHERE kind = 'card.acting' AND client_id = 'cl-a-1' ORDER BY at, id`;
  assert.deepEqual(feed.map((f) => f.data.actingUserId), [U.opB, null]);
  // повтор той же задачи ничего не снимает
  const idem = await runAbsences(sys(clock.now), { spaceId: SPACE, runId: uuid(), now: clock.now });
  assert.deepEqual(idem, { ended: 0, released: 0, acting: 0 });
});

test('«поровну»: кандидаты opB и дежурный, нагрузка учитывается; отмена снимает сразу у всех', async () => {
  await reset();
  await seedScenario();
  // у B уже одна открытая новая: нагрузка выше → дежурному достаётся больше
  await db.sql`UPDATE cards SET state = 'new' WHERE id = 'cd-b-1'`;
  const r = await createAbsence(rop, { opId: uuid(), userId: U.opA, fromDay: '2026-10-28', toDay: '2026-10-30', substituteUserId: null });
  assert.deepEqual(r.applied, { acting: 3, released: 1 });
  const actings = await db.sql<{ acting: string; n: number }>`SELECT acting_user_id AS acting, count(*)::int AS n FROM cards WHERE acting_user_id IS NOT NULL GROUP BY 1 ORDER BY 1`;
  assert.deepEqual(actings.map((a) => [a.acting, a.n]), [[U.duty, 2], [U.opB, 1]]);
  const audit = await db.sql<{ meta: { even: boolean } }>`SELECT meta FROM audit_log WHERE action = 'distribution.absence' ORDER BY created_at DESC LIMIT 1`;
  assert.equal(audit[0]?.meta.even, true);

  const view = await cancelAbsence(rop, r.id);
  assert.equal(view.id, r.id);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE acting_user_id IS NOT NULL`).length, 0);
  assert.equal((await listAbsences(rop)).length, 0);
  const again = await cancelAbsence(rop, r.id);
  assert.equal(again.id, r.id, 'повтор отмены — прежний ответ');
  await assert.rejects(cancelAbsence(rop, 'no-such-absence'), NotFoundError);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'distribution.absence_cancel'`)[0]!.n, 1);
});

test('«поровну» без кандидатов — 409 no_substitute, ничего не создано; задача без заместителя уведомляет руководителя', async () => {
  await reset();
  await seedScenario();
  await db.sql`UPDATE memberships SET in_distribution = FALSE WHERE user_id IN (${U.opB}, ${U.duty})`;
  const e = await failure(createAbsence(rop, { opId: uuid(), userId: U.opA, fromDay: '2026-10-28', toDay: '2026-10-30', substituteUserId: null }));
  assert.deepEqual([e?.code, e?.status], ['no_substitute', 409]);
  assert.equal((await db.sql`SELECT 1 FROM absences`).length, 0);
  // заместитель назначен, но к моменту задачи ушёл в отсутствие: карточки остаются у владельца, РОП получает уведомление
  await db.sql`UPDATE memberships SET in_distribution = TRUE WHERE user_id IN (${U.opB}, ${U.duty})`;
  const abs = await createAbsence(rop, { opId: uuid(), userId: U.opA, fromDay: '2026-10-29', toDay: '2026-10-30', substituteUserId: U.opB });
  assert.deepEqual(abs.applied, { acting: 0, released: 0 }, 'ещё не началось');
  await db.sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, created_at) VALUES ('ab-b', ${SPACE}, ${U.opB}, '2026-10-29', '2026-10-30', ${SEED_NOW})`;
  clock.now = local('2026-10-29', '07:30');
  const r = await runAbsences(sys(clock.now), { spaceId: SPACE, runId: uuid(), now: clock.now });
  assert.equal(r.acting, 0);
  assert.equal((await cardState('cd-a-1')).acting, null);
  const n = await db.sql<{ userId: string; params: { count: number } }>`SELECT user_id, params FROM notifications WHERE kind = 'absence_no_substitute'`;
  assert.equal(n.length, 1);
  assert.equal(n[0]?.userId, U.rop);
});

test('группа двойников уходит одному «поровну»', async () => {
  await reset();
  await db.sql`DELETE FROM absences`;
  await setCard(db.sql, 'cd-a-1', { state: 'callback', nextCallAt: SEED_NOW - HOUR });
  await setCard(db.sql, 'cd-a-2', { state: 'callback', nextCallAt: SEED_NOW - HOUR });
  await setCard(db.sql, 'cd-a-3', { state: 'callback', nextCallAt: SEED_NOW - HOUR });
  await db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, created_at) VALUES ('dp-ab-1', 'cl-a-1', 'cl-a-2', 'shared_phone', 'open', ${SEED_NOW})`;
  await db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, created_at) VALUES ('dp-ab-2', 'cl-a-2', 'cl-a-3', 'shared_phone', 'open', ${SEED_NOW})`;
  await createAbsence(rop, { opId: uuid(), userId: U.opA, fromDay: '2026-10-28', toDay: '2026-10-28', substituteUserId: null });
  const who = new Set((await db.sql<{ acting: string }>`SELECT acting_user_id AS acting FROM cards WHERE id IN ('cd-a-1','cd-a-2','cd-a-3')`).map((r) => r.acting));
  assert.equal(who.size, 1);
  await db.sql`DELETE FROM dup_pairs WHERE id LIKE 'dp-ab-%'`;
});

test('взаимное замещение: временный, ставший владельцем, просто снимается; чужие карточки переходят новому временному', async () => {
  await reset();
  // B замещает A на двух карточках A до 02.11; теперь B уходит, заместитель — сам A
  await db.sql`UPDATE cards SET acting_user_id = ${U.opB}, acting_until_day = '2026-11-02', state = 'callback', next_call_at = ${SEED_NOW + 3 * DAY} WHERE id IN ('cd-a-1','cd-a-2')`;
  await db.sql`UPDATE cards SET owner_user_id = ${U.duty}, acting_user_id = ${U.opB}, acting_until_day = '2026-11-01', state = 'callback', next_call_at = ${SEED_NOW + 3 * DAY} WHERE id = 'cd-a-3'`;
  await db.sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, substitute_user_id, created_at) VALUES ('ab-mutual', ${SPACE}, ${U.opB}, '2026-10-28', '2026-10-30', ${U.opA}, ${SEED_NOW})`;
  const r = await runAbsences(sys(clock.now), { spaceId: SPACE, runId: uuid(), now: clock.now });
  assert.equal(r.acting, 3);
  for (const id of ['cd-a-1', 'cd-a-2']) {
    const c = await cardState(id);
    assert.deepEqual([c.owner, c.acting, c.until], [U.opA, null, ''], `${id}: временный стал владельцем — снят`);
  }
  const c3 = await cardState('cd-a-3');
  assert.deepEqual([c3.owner, c3.acting, c3.until], [U.duty, U.opA, '2026-11-01'], 'срок прежний, временный новый');
  assert.deepEqual((await logOf('absence', 'cd-a-1')).map((l) => [l.fromUserId, l.toUserId]), [[U.opB, U.opA]]);
  assert.deepEqual((await logOf('absence', 'cd-a-3')).map((l) => [l.fromUserId, l.toUserId]), [[U.duty, U.opA]]);
});

test('«Пауза»: тик ничего не выдаёт, назавтра выдаёт; снятие; прав у оператора нет', async () => {
  await reset();
  await seedPool(db.sql, 4);
  const view = await setPause(rop, { userId: U.opA, paused: true });
  assert.equal(view.status, 'paused');
  await systemTick();
  const issuedA = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE id LIKE 'pc-%' AND owner_user_id = ${U.opA}`;
  assert.equal(issuedA[0]!.n, 0, 'на паузе новые не выдаются');
  assert.ok((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE id LIKE 'pc-%' AND owner_user_id IS NOT NULL`)[0]!.n > 0, 'остальным выдано');
  await db.sql`UPDATE cards SET owner_user_id = NULL WHERE id LIKE 'pc-%'`;
  clock.now = SEED_NOW + DAY;
  await systemTick();
  assert.ok((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE id LIKE 'pc-%' AND owner_user_id = ${U.opA}`)[0]!.n > 0, 'назавтра пауза не действует');
  clock.now = SEED_NOW;
  assert.equal((await setPause(rop, { userId: U.opA, paused: false })).status, 'working');
  const audit = await db.sql<{ meta: { paused: boolean } }>`SELECT meta FROM audit_log WHERE action = 'distribution.pause'`;
  assert.deepEqual(audit.map((a) => a.meta.paused).sort(), [false, true]);
  await assert.rejects(setPause(opA, { userId: U.opB, paused: true }), ForbiddenError);
  await assert.rejects(setPause(rop, { userId: U.consultant, paused: true }), NotFoundError, 'не участник раздачи');
});

/** Тик с окном на все сутки: проверяется статус участников, а не расписание. */
async function systemTick(): Promise<void> {
  const cfg = await loadDistributionConfig(SPACE, clock.now);
  const deps = { config: async () => ({ ...cfg, settings: { ...cfg.settings, mode: 'auto_even' as const, dailyCap: 40, capIncludes: ['auto', 'manual', 'return'] as const, schedule: { from: '00:00', to: '23:59', everyMin: 60, workdaysOnly: false } } }), now: () => clock.now };
  await runTick(systemActor('distribute@sales', clock.now), { spaceId: SPACE, runId: uuid(), slotAt: clock.now, now: clock.now }, deps);
}

test('«Без владельца (не новые)»: список, назначение двух карточек, повтор opId без дублей, устаревшая версия', async () => {
  await reset();
  await setCard(db.sql, 'cd-a-30', { state: 'retry', owner: null });
  await setCard(db.sql, 'cd-a-31', { state: 'callback', owner: null });
  await setCard(db.sql, 'cd-a-32', { state: 'new', owner: null });
  const page = await listOwnerless(rop, { cursor: null, limit: 50 });
  assert.deepEqual(page.items.map((i) => i.cardId).sort(), ['cd-a-30', 'cd-a-31']);
  assert.equal(page.next, null);
  assert.equal((await getPool(rop, { cursor: null, limit: 10 })).summary.ownerless, 2);

  const opId = uuid();
  const items = page.items.map((i) => ({ cardId: i.cardId, version: i.version }));
  const r = await assignOwnerless(rop, { opId, toUserId: U.opB, items });
  assert.deepEqual([r.assigned, r.skipped, r.replayed], [2, [], false]);
  assert.equal((await cardState('cd-a-30')).owner, U.opB);
  const tr = await logOf('transfer');
  assert.deepEqual(tr.map((l) => [l.cardId, l.fromUserId, l.toUserId, l.countsToCap, l.runId]), [
    ['cd-a-30', null, U.opB, false, opId],
    ['cd-a-31', null, U.opB, false, opId],
  ]);
  const again = await assignOwnerless(rop, { opId, toUserId: U.opB, items });
  assert.deepEqual([again.assigned, again.replayed], [2, true]);
  assert.equal((await logOf('transfer')).length, 2, 'повтор без дублей');
  assert.equal((await listOwnerless(rop, { cursor: null, limit: 50 })).items.length, 0);

  await setCard(db.sql, 'cd-a-33', { state: 'retry', owner: null });
  const stale = await assignOwnerless(rop, { opId: uuid(), toUserId: U.opB, items: [{ cardId: 'cd-a-33', version: 99 }, { cardId: 'cd-a-1', version: 0 }, { cardId: 'no-card', version: 0 }] });
  assert.deepEqual([stale.assigned, stale.skipped.map((s) => s.reason)], [0, ['changed', 'changed', 'changed']]);
});

test('«Без владельца»: получатель на паузе — not_working; оператору раздел закрыт', async () => {
  await reset();
  await setCard(db.sql, 'cd-a-34', { state: 'retry', owner: null });
  await setPause(rop, { userId: U.opB, paused: true });
  const e = await failure(assignOwnerless(rop, { opId: uuid(), toUserId: U.opB, items: [{ cardId: 'cd-a-34', version: 0 }] }));
  assert.deepEqual([e?.code, e?.status], ['not_working', 409]);
  const e2 = await failure(assignOwnerless(rop, { opId: uuid(), toUserId: U.consultant, items: [{ cardId: 'cd-a-34', version: 0 }] }));
  assert.equal(e2?.code, 'not_participant');
  await assert.rejects(assignOwnerless(opA, { opId: uuid(), toUserId: U.opB, items: [{ cardId: 'cd-a-34', version: 0 }] }), ForbiddenError);
  await assert.rejects(listOwnerless(opA, { cursor: null, limit: 10 }), ForbiddenError);
  await assert.rejects(createAbsence(opA, { opId: uuid(), userId: U.opB, fromDay: '2026-10-28', toDay: '2026-10-29', substituteUserId: null }), ForbiddenError);
});

test('определение задачи absence: ежедневно в 07:30, включая выходные, пишет бизнес-данные', () => {
  assert.equal(absenceJob.name, 'absence');
  assert.equal(absenceJob.perSpace, true);
  assert.equal(absenceJob.writes, 'business');
  assert.deepEqual(absenceJob.schedule({ global: {}, space: {} }), { kind: 'daily', at: '07:30', days: 'all' });
});
