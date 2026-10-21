// «Мои консультации» и итог встречи (B5c, §4.9, D-246): окно доступа консультанта, имена только в окне,
// заметка, ручная задача, этап сделки, идемпотентность по opId.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { getMyConsultation, listMyConsultations, recordConsultResult } from '../../../src/server/domain/booking/consultations';
import type { ConsultResultInput } from '../../../src/server/domain/booking/consultTypes';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import { createDealLink } from '../../../src/server/domain/deals/effects';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import type { PipelineInfo } from '../../../src/server/domain/deals/pipelines';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FX, U } from '../../isolation/harness/seed';
import { SEED_NOW, closeConsultWorld, fakeCardPort, insertGrey, makeDeps, openConsultWorld, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let cons: Viewer;
let rop: Viewer;
const clock = { now: SEED_NOW };
const TODAY = '2026-10-28';
const DAY = 86_400_000;

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const input = (over: Partial<ConsultResultInput> = {}): ConsultResultInput => ({
  bookingId: FX.bkInWindow.booking,
  opId: uuid(),
  note: 'Обсудили маркетинг',
  nextStep: { dueAt: SEED_NOW + DAY, kind: 'call' },
  toStageKey: 'offer',
  dealVersion: 0,
  ...over,
});

before(async () => {
  db = await openConsultWorld();
  deps = makeDeps(clock, fakeCardPort());
  cons = await viewerOf(U.consultant);
  rop = await viewerOf(U.rop);
  await db.sql`UPDATE resources SET active = TRUE WHERE id IN ('rs-cons', 'rs-rop')`;
  // клиент завтрашней БК: сделка на этапе «Записан»
  await db.sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, version, created_by, created_at, updated_at)
    VALUES ('dl-consult', 'sp-sales', 'sales', 'booked', 'open', ${FX.bkInWindow.client}, ${FX.bkInWindow.card}, ${U.opB}, ${SEED_NOW}, 0, ${U.opB}, ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`UPDATE bookings SET deal_id = 'dl-consult' WHERE id = ${FX.bkInWindow.booking}`;
});
after(() => closeConsultWorld(db));

test('мои консультации: свои записи на 14 дней, имена — только в окне, чужие и прошлые не видны', async () => {
  await insertGrey(db.sql, { id: 'bk-today', client: 'cl-b-20', card: 'cd-b-20', date: TODAY, time: '15:00', resourceId: 'rs-cons' });
  const list = await listMyConsultations(deps, cons, { from: TODAY, to: '2026-11-11' });
  assert.deepEqual(list.map((c) => c.bookingId), ['bk-today', FX.bkInWindow.booking, FX.bkFuture.booking]);
  const byId = Object.fromEntries(list.map((c) => [c.bookingId, c]));
  assert.equal(byId['bk-today']!.inWindow, true);
  assert.ok(byId['bk-today']!.clientName);
  assert.equal(byId[FX.bkInWindow.booking]!.inWindow, true);
  assert.equal(byId[FX.bkInWindow.booking]!.clientId, FX.bkInWindow.client);
  // через два дня окно ещё не открылось: ни имени, ни id клиента, карточки и сделки
  const later = byId[FX.bkFuture.booking]!;
  assert.deepEqual([later.inWindow, later.clientId, later.cardId, later.clientName, later.dealId], [false, null, null, null, null]);
  assert.equal(later.startTime, '11:00');
  // прошлое за пределами запрошенных дат; БК другого консультанта не видна совсем
  assert.ok(!list.some((c) => c.bookingId === FX.bkOther.booking || c.bookingId === FX.bkPast.booking));
  // РОП — тоже консультант (rs-rop): своя запись с именем (охват пространства)
  const mine = await listMyConsultations(deps, rop, { from: TODAY, to: '2026-11-11' });
  assert.deepEqual(mine.map((c) => [c.bookingId, c.inWindow]), [[FX.bkOther.booking, true]]);
});

test('окно дат: не больше 62 дней, from ≤ to, формат даты', async () => {
  for (const bad of [{ from: TODAY, to: '2027-02-01' }, { from: '2026-11-11', to: TODAY }, { from: '28.10.2026', to: TODAY }]) {
    await assert.rejects(listMyConsultations(deps, cons, bad), (e: unknown) => e instanceof BadRequestError);
  }
});

test('страница встречи: своя видна, чужая и ещё закрытая — 404; следующий этап воронки и версия сделки', async () => {
  const v = await getMyConsultation(deps, cons, FX.bkInWindow.booking);
  assert.deepEqual([v.clientName !== '', v.canRecordResult, v.deal?.id, v.deal?.pipelineKey, v.deal?.stageKey, v.deal?.version], [true, false, 'dl-consult', 'sales', 'booked', 0]);
  assert.deepEqual(v.laterStages.map((x) => x.key), ['attended', 'offer']);
  for (const id of [FX.bkOther.booking, FX.bkFuture.booking, FX.bkPast.booking, 'нет-такой']) {
    await assert.rejects(getMyConsultation(deps, cons, id), (e: unknown) => e instanceof BookingDomainError && e.code === 'booking_not_found');
  }
});

test('итог до явки — not_attended; пустой итог и плохие значения — 400; чужая встреча — 404', async () => {
  await assert.rejects(recordConsultResult(deps, cons, input()), failsWith('not_attended'));
  await db.sql`UPDATE bookings SET status = 'attended' WHERE id = ${FX.bkInWindow.booking}`;
  await assert.rejects(recordConsultResult(deps, cons, input({ note: '  ', nextStep: null, toStageKey: null, dealVersion: null })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(recordConsultResult(deps, cons, input({ note: 'x'.repeat(2001) })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(recordConsultResult(deps, cons, input({ nextStep: { dueAt: SEED_NOW - 1, kind: 'call' } })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(recordConsultResult(deps, cons, input({ dealVersion: null })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(recordConsultResult(deps, cons, input({ bookingId: FX.bkOther.booking })), (e: unknown) => e instanceof NotFoundError || (e instanceof BookingDomainError && e.code === 'booking_not_found'));
  await assert.rejects(recordConsultResult(deps, cons, input({ bookingId: FX.bkFuture.booking })), (e: unknown) => e instanceof NotFoundError || (e instanceof BookingDomainError && e.code === 'booking_not_found'));
});

test('итог: заметка, ручная задача себе, этап «offer», событие booking.result; повтор opId — один результат', async () => {
  const body = input();
  const out = await recordConsultResult(deps, cons, body);
  assert.equal(out.replayed, false);
  assert.equal(out.noteId, body.opId);
  assert.ok(out.taskId);
  const note = await db.sql<{ body: string; authorId: string; dealId: string; clientId: string }>`SELECT body, author_id, deal_id, client_id FROM notes WHERE id = ${out.noteId}`;
  assert.deepEqual(note.map((n) => [n.body, n.authorId, n.dealId, n.clientId]), [['Обсудили маркетинг', U.consultant, 'dl-consult', FX.bkInWindow.client]]);
  const task = await db.sql<{ source: string; kind: string; sourceKey: string | null; assigneeUserId: string; dueAt: number; dealId: string }>`SELECT source, kind, source_key, assignee_user_id, due_at, deal_id FROM tasks WHERE id = ${out.taskId}`;
  assert.deepEqual(task.map((t) => [t.source, t.kind, t.sourceKey, t.assigneeUserId, t.dueAt, t.dealId]), [['manual', 'call', null, U.consultant, SEED_NOW + DAY, 'dl-consult']]);
  const deal = await db.sql<{ stageKey: string; version: number }>`SELECT stage_key, version FROM deals WHERE id = 'dl-consult'`;
  assert.deepEqual([deal[0]!.stageKey, deal[0]!.version], ['offer', 1]);
  const feed = await db.sql<{ kind: string; id: string }>`SELECT kind, id FROM client_events WHERE client_id = ${FX.bkInWindow.client} AND kind IN ('booking.result', 'deal.stage', 'note.created') ORDER BY kind`;
  assert.deepEqual(feed.map((f) => f.kind), ['booking.result', 'deal.stage', 'note.created']);
  assert.equal(feed.find((f) => f.kind === 'booking.result')!.id, body.opId);

  const again = await recordConsultResult(deps, cons, { ...body, note: 'Другой текст' });
  assert.deepEqual([again.replayed, again.noteId, again.taskId], [true, out.noteId, out.taskId]);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notes WHERE client_id = ${FX.bkInWindow.client}`)[0]!.n, 1);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM tasks WHERE deal_id = 'dl-consult' AND source = 'manual'`)[0]!.n, 1);
  // тот же opId на другой встрече — request_reused
  await assert.rejects(recordConsultResult(deps, rop, input({ bookingId: FX.bkOther.booking, opId: body.opId })), (e: unknown) => e instanceof BookingDomainError);
});

test('этап: назад без deal.move_back — 403, на неизвестный — 400, «проигран» — 400, устаревшая версия — 409; без этапа сделка не трогается', async () => {
  const stage = async () => (await db.sql<{ stageKey: string }>`SELECT stage_key FROM deals WHERE id = 'dl-consult'`)[0]!.stageKey;
  await assert.rejects(recordConsultResult(deps, cons, input({ toStageKey: 'booked', dealVersion: 1 })), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(recordConsultResult(deps, cons, input({ toStageKey: 'нет', dealVersion: 1 })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(recordConsultResult(deps, cons, input({ toStageKey: 'lost', dealVersion: 1 })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(recordConsultResult(deps, cons, input({ toStageKey: 'attended', dealVersion: 0 })), (e: unknown) => e instanceof ConflictError);
  assert.equal(await stage(), 'offer');
  const notesBefore = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notes`)[0]!.n;
  const plain = await recordConsultResult(deps, cons, input({ toStageKey: null, dealVersion: null, nextStep: null }));
  assert.ok(plain.noteId);
  assert.equal(await stage(), 'offer');
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notes`)[0]!.n, notesBefore + 1);
});

test('этап итога проходит общую проверку требований: шаг с датой (шаг этого же итога засчитан) и поля сделки', async () => {
  const NONE = { fields: [], booking: false, attendance: false, nextTask: false };
  const withRequires: PipelineInfo[] = [
    {
      key: 'sales',
      createDealOn: 'agreed',
      stages: [
        { key: 'booked', kind: 'open', order: 10, auto: 'on_agreed', requires: NONE },
        { key: 'attended', kind: 'open', order: 20, auto: 'on_attended', requires: NONE },
        { key: 'offer', kind: 'open', order: 30, auto: null, requires: { ...NONE, nextTask: true } },
        { key: 'contract', kind: 'open', order: 35, auto: null, requires: { ...NONE, fields: ['budget'] } },
        { key: 'lost', kind: 'lost', order: 50, auto: null, requires: NONE },
      ],
    },
  ];
  const strict: BookingDeps = { ...deps, deals: createDealLink(async () => withRequires) };
  await db.sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, version, created_by, created_at, updated_at)
    VALUES ('dl-req', 'sp-sales', 'sales', 'attended', 'open', ${FX.bkInWindow.client}, ${FX.bkInWindow.card}, ${U.opB}, ${SEED_NOW}, 0, ${U.opB}, ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`UPDATE bookings SET deal_id = 'dl-req' WHERE id = ${FX.bkInWindow.booking}`;
  const stageOf = async () => (await db.sql<{ stageKey: string; version: number }>`SELECT stage_key, version FROM deals WHERE id = 'dl-req'`)[0]!;
  const notesBefore = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notes`)[0]!.n;
  const dealFails = (code: string, fields?: string[]) => (e: unknown) =>
    e instanceof DealDomainError && e.code === code && (fields === undefined || JSON.stringify(e.fields) === JSON.stringify(fields));

  // «Переговоры» требуют шаг с датой: итог без шага — тот же отказ, что у POST /api/deals/[id]/stage; ничего не записано
  await assert.rejects(recordConsultResult(strict, cons, input({ note: 'x', nextStep: null, toStageKey: 'offer', dealVersion: 0 })), dealFails('next_step_required'));
  assert.deepEqual([(await stageOf()).stageKey, (await stageOf()).version], ['attended', 0]);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notes`)[0]!.n, notesBefore);
  // шаг этого же итога засчитан
  await recordConsultResult(strict, cons, input({ note: 'x', toStageKey: 'offer', dealVersion: 0 }));
  assert.deepEqual([(await stageOf()).stageKey, (await stageOf()).version], ['offer', 1]);

  // «Договор» требует поле сделки
  await assert.rejects(recordConsultResult(strict, cons, input({ note: 'x', nextStep: null, toStageKey: 'contract', dealVersion: 1 })), dealFails('stage_fields_required', ['budget']));
  assert.equal((await stageOf()).stageKey, 'offer');
  await db.sql`UPDATE deals SET custom = '{"budget": "синтетика"}'::jsonb WHERE id = 'dl-req'`;
  await recordConsultResult(strict, cons, input({ note: 'x', nextStep: null, toStageKey: 'contract', dealVersion: 1 }));
  assert.equal((await stageOf()).stageKey, 'contract');
});
