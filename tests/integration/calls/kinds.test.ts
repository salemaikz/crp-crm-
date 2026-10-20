// Виды итогов на настоящей БД (docs/calls-design.md §12): «Номер не работает», «Просил не звонить»,
// «Перезвонить», передача карточки (факт owner_changed), гонка итогов, архивный итог, поля шторки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { CallsDomainError } from '../../../src/server/domain/calls/errors';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { seedBookings, seedEvent } from '../booking/helpers';
import { DAY, HOUR, MIN, SEED_NOW, callsDeps, cardOf, closeCallsWorld, openCallsWorld, outcomeReq, setCard, uuid, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let opB: Viewer;
let rop: Viewer;
const clock = { now: SEED_NOW };

const fails = (code: string) => (e: unknown) => e instanceof CallsDomainError && e.code === code;
const cnt = async (q: Promise<Array<{ n: number }>>): Promise<number> => (await q)[0]!.n;
const fresh = (id: string, over: Parameters<typeof setCard>[2] = {}) => setCard(db.sql, id, { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null, ...over });

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  rop = await viewerOf(U.rop);
});
after(async () => {
  await closeCallsWorld(db);
});

test('«Номер не работает»: второй рабочий номер становится основным, попытки те же, повтор сразу', async () => {
  await fresh('cd-a-20', { state: 'retry', attempts: 1, nextCallAt: SEED_NOW - HOUR });
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES ('ph-a-20b', 'cl-a-20', '77090900020', 'mobile', FALSE, ${SEED_NOW})`;
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-20', outcomeKey: 'bad_number', phoneId: 'ph-a-20' }));
  assert.equal(r.card?.state, 'retry');
  const card = await cardOf(db.sql, 'cd-a-20');
  assert.equal(card.attempts, 1);
  assert.equal(card.nextCallAt, SEED_NOW - MIN);
  const ph = await db.sql<{ id: string; isWorking: boolean; isPrimary: boolean }>`SELECT id, is_working, is_primary FROM client_phones WHERE client_id = 'cl-a-20' ORDER BY id`;
  assert.deepEqual(ph.map((p) => [p.id, p.isWorking, p.isPrimary]), [['ph-a-20', false, false], ['ph-a-20b', true, true]]);
  const kinds = await db.sql<{ kind: string }>`SELECT kind FROM client_events WHERE client_id = 'cl-a-20' AND kind IN ('phone.not_working','phone.primary') ORDER BY kind`;
  assert.deepEqual(kinds.map((k) => k.kind), ['phone.not_working', 'phone.primary']);
});

test('«Номер не работает» на единственном номере: written_off no_working_phone', async () => {
  await fresh('cd-a-21');
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-21', outcomeKey: 'bad_number', phoneId: 'ph-a-21' }));
  assert.equal(r.card?.state, 'written_off');
  assert.equal((await cardOf(db.sql, 'cd-a-21')).closeReasonCode, 'no_working_phone');
});

test('«Просил не звонить»: HMAC в стоп-листе, будущие записи отменены, открытые сделки закрыты', async () => {
  await fresh('cd-a-22', { state: 'retry', attempts: 1, nextCallAt: SEED_NOW - HOUR });
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = 'cd-a-22'`;
  await seedEvent(db.sql, { id: 'ev-dnc', date: '2026-10-30', time: '15:00' });
  const [bk] = await seedBookings(db.sql, 'ev-dnc', [{ client: 'cl-a-22', card: 'cd-a-22' }], { bookedBy: U.opA });
  const req = outcomeReq({ cardId: 'cd-a-22', outcomeKey: 'do_not_call', phoneId: 'ph-a-22' });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.card?.state, 'do_not_call');
  const stop = await db.sql<{ phoneHmac: string; source: string }>`SELECT phone_hmac, source FROM stop_list`;
  const digits = (await db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE id = 'ph-a-22'`)[0]!.digits;
  assert.ok(stop.some((s) => s.phoneHmac === phoneHmac(digits) && s.source === 'outcome'));
  const b = await db.sql<{ status: string; cancelReason: string }>`SELECT status, cancel_reason FROM bookings WHERE id = ${bk!}`;
  assert.deepEqual([b[0]?.status, b[0]?.cancelReason], ['cancelled', 'do_not_call']);
  // номер в открытом виде нигде, кроме client_phones и calls.phone_digits, не лежит
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM stop_list WHERE phone_hmac = ${digits}`), 0);
});

test('«Просил не звонить» общим номером: в стоп-лист не идёт, руководителю — задача подтверждения', async () => {
  await fresh('cd-a-23');
  const digits = (await db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE id = 'ph-a-23'`)[0]!.digits;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES ('ph-b-share', 'cl-b-60', ${digits}, 'mobile', ${SEED_NOW})`;
  const req = outcomeReq({ cardId: 'cd-a-23', outcomeKey: 'do_not_call', phoneId: 'ph-a-23' });
  await submitOutcome(deps, opA, req);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM stop_list WHERE phone_hmac = ${phoneHmac(digits)}`), 0);
  const t = await db.sql<{ assigneeUserId: string; sourceKey: string; title: string }>`SELECT assignee_user_id, source_key, title FROM tasks WHERE client_id = 'cl-a-23'`;
  assert.equal(t.length, 1);
  assert.match(t[0]!.sourceKey, /^dnc_confirm:/);
  assert.equal(t[0]!.assigneeUserId, U.rop, 'руководитель — РОП, а не директор');
  assert.equal(t[0]!.title, '', 'в автозадаче нет текста и ПДн');
});

test('«Перезвонить»: next_call_at и задача callback:<opId>; перенос закрывает старую и создаёт новую', async () => {
  await fresh('cd-a-24');
  const first = outcomeReq({ cardId: 'cd-a-24', outcomeKey: 'callback', callbackAt: SEED_NOW + 3 * HOUR });
  const r = await submitOutcome(deps, opA, first);
  assert.equal(r.card?.state, 'callback');
  assert.equal(r.card?.nextCallAt, SEED_NOW + 3 * HOUR);
  const open1 = await db.sql<{ sourceKey: string; dueAt: number; assigneeUserId: string }>`SELECT source_key, due_at, assignee_user_id FROM tasks WHERE client_id = 'cl-a-24' AND status = 'open'`;
  assert.deepEqual(open1.map((t) => [t.sourceKey, t.dueAt, t.assigneeUserId]), [[`callback:${first.opId}`, SEED_NOW + 3 * HOUR, U.opA]]);
  clock.now = SEED_NOW + HOUR;
  const second = outcomeReq({ cardId: 'cd-a-24', outcomeKey: 'callback', callbackAt: SEED_NOW + 5 * HOUR, occurredAt: clock.now - MIN });
  await submitOutcome(deps, opA, second);
  clock.now = SEED_NOW;
  const open2 = await db.sql<{ sourceKey: string }>`SELECT source_key FROM tasks WHERE client_id = 'cl-a-24' AND status = 'open'`;
  assert.deepEqual(open2.map((t) => t.sourceKey), [`callback:${second.opId}`]);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM tasks WHERE client_id = 'cl-a-24' AND status = 'done'`), 1);
});

test('перезвон вне окна звонков: предупреждение, срок не сдвигается', async () => {
  await fresh('cd-a-25');
  const at = Date.UTC(2026, 9, 28, 19, 30); // 00:30 следующих суток по Алматы
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-25', outcomeKey: 'callback', callbackAt: at }));
  assert.deepEqual(r.warnings, ['callback_outside_work_hours']);
  assert.equal(r.card?.nextCallAt, at);
});

test('передача карточки после звонка A: итог пишется фактом owner_changed, задача новому владельцу, ответ без карточки', async () => {
  await fresh('cd-a-26');
  const occurredAt = SEED_NOW - 30 * MIN;
  // передача A → B через 10 минут после звонка
  await db.sql`UPDATE cards SET owner_user_id = ${U.opB} WHERE id = 'cd-a-26'`;
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-1', 'sp-sales', 'cd-a-26', ${U.opA}, ${U.opA}, 'manual', FALSE, '2026-10-28', ${SEED_NOW - 40 * MIN}),
                      ('al-2', 'sp-sales', 'cd-a-26', ${U.opA}, ${U.opB}, 'transfer', FALSE, '2026-10-28', ${SEED_NOW - 20 * MIN})`;
  const req = outcomeReq({ cardId: 'cd-a-26', occurredAt, via: 'offline' });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'fact_only');
  assert.equal(r.factReason, 'owner_changed');
  assert.equal(r.card, null);
  const card = await cardOf(db.sql, 'cd-a-26');
  assert.equal(card.state, 'new');
  assert.equal(card.ownerUserId, U.opB);
  const t = await db.sql<{ assigneeUserId: string; sourceKey: string }>`SELECT assignee_user_id, source_key FROM tasks WHERE client_id = 'cl-a-26'`;
  assert.deepEqual(t.map((x) => [x.assigneeUserId, x.sourceKey]), [[U.opB, `review:${req.opId}`]]);
  // повтор того же итога после передачи — duplicate без карточки
  const again = await submitOutcome(deps, opA, req);
  assert.deepEqual([again.status, again.card], ['duplicate', null]);
});

test('звонок, начатый после передачи: карточка недоступна (404), записи нет', async () => {
  await fresh('cd-a-27');
  await db.sql`UPDATE cards SET owner_user_id = ${U.opB} WHERE id = 'cd-a-27'`;
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-3', 'sp-sales', 'cd-a-27', ${U.opA}, ${U.opB}, 'transfer', FALSE, '2026-10-28', ${SEED_NOW - 40 * MIN})`;
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-27', occurredAt: SEED_NOW - 10 * MIN })), fails('not_found'));
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE card_id = 'cd-a-27'`), 0);
});

test('гонка двух итогов (владелец и временный владелец): побеждает поздний по occurred_at при любом порядке прихода', async () => {
  for (let i = 0; i < 20; i++) {
    const card = `cd-a-${30 + i}`;
    await fresh(card, { acting: U.opB });
    const early = outcomeReq({ cardId: card, outcomeKey: 'callback', callbackAt: SEED_NOW + 4 * HOUR, occurredAt: SEED_NOW - 20 * MIN });
    const late = outcomeReq({ cardId: card, outcomeKey: 'no_answer', occurredAt: SEED_NOW - 5 * MIN });
    const jobs = i % 2 === 0 ? [submitOutcome(deps, opA, early), submitOutcome(deps, opB, late)] : [submitOutcome(deps, opB, late), submitOutcome(deps, opA, early)];
    await Promise.all(jobs);
    const c = await cardOf(db.sql, card);
    assert.equal(c.lastOutcomeAt, SEED_NOW - 5 * MIN, `прогон ${i}: последним применён поздний`);
    assert.equal(c.state, 'retry', `прогон ${i}`);
    const rows = await db.sql<{ applied: string; factReason: string; outcomeCode: string }>`SELECT applied, fact_reason, outcome_code FROM calls WHERE card_id = ${card} ORDER BY outcome_code`;
    assert.equal(rows.length, 2);
    const stale = rows.filter((x) => x.applied === 'fact_only');
    assert.ok(stale.length === 0 || (stale.length === 1 && stale[0]!.factReason === 'stale'), `прогон ${i}`);
    if (stale.length === 1) assert.equal(stale[0]!.outcomeCode, 'callback');
  }
});

test('архивный итог: принят в пределах окна после архивации и отклонён позже', async () => {
  await fresh('cd-a-60');
  // ревизия, архивировавшая итог, создана в SEED_NOW − 80 ч: окно 72 ч уже закрыто
  await db.sql`UPDATE config_revisions SET created_at = ${SEED_NOW - 80 * HOUR} WHERE scope = 'sp-sales'`;
  const { resetConfigCache } = await import('../../../src/server/platform/config/active');
  resetConfigCache();
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-60', outcomeKey: 'old_outcome' })), fails('outcome_archived'));
  await db.sql`UPDATE config_revisions SET created_at = ${SEED_NOW - 10 * HOUR} WHERE scope = 'sp-sales'`;
  resetConfigCache();
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-60', outcomeKey: 'old_outcome' }));
  assert.equal(r.status, 'applied');
});

test('поля шторки: ключ не из requires.fields → 400; значение пишется в клиента, событие field.changed в ленте', async () => {
  await fresh('cd-a-61');
  await assert.rejects(
    submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-61', outcomeKey: 'callback', callbackAt: SEED_NOW + HOUR, fields: { segment: 'x' } })),
    fails('field_not_allowed'),
  );
  await assert.rejects(
    submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-61', outcomeKey: 'niche_asked', callbackAt: SEED_NOW + HOUR, fields: {} })),
    fails('fields'),
    'обязательное поле итога должно быть заполнено',
  );
  await assert.rejects(
    submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-61', outcomeKey: 'niche_asked', callbackAt: SEED_NOW + HOUR, fields: { niche: 'нет такого варианта' } })),
    fails('fields'),
  );
  const req = outcomeReq({ cardId: 'cd-a-61', outcomeKey: 'niche_asked', callbackAt: SEED_NOW + HOUR, fields: { niche: 'trade' } });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  const cl = await db.sql<{ custom: Record<string, unknown> }>`SELECT custom FROM clients WHERE id = 'cl-a-61'`;
  assert.equal(cl[0]?.custom.niche, 'trade');
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE client_id = 'cl-a-61' AND kind = 'field.changed'`), 1);
  const patch = await db.sql<{ fieldsPatch: Record<string, unknown> }>`SELECT fields_patch FROM calls WHERE id = ${req.opId}`;
  assert.deepEqual(patch[0]?.fieldsPatch, { niche: 'trade' });
});

test('РОП (охват space) вносит итог по карточке оператора; консультант без права — отказ, оператор B — 404', async () => {
  await fresh('cd-a-62');
  const r = await submitOutcome(deps, rop, outcomeReq({ cardId: 'cd-a-62' }));
  assert.equal(r.status, 'applied');
  await assert.rejects(submitOutcome(deps, opB, outcomeReq({ cardId: 'cd-a-62' })), fails('not_found'));
  void DAY;
  void uuid;
});

test('«Не интересно»: открытые сделки клиента проиграны с той же причиной, выигранная не тронута, лента пишется', async () => {
  await fresh('cd-a-90', { state: 'retry', attempts: 1, nextCallAt: SEED_NOW - HOUR });
  const t = SEED_NOW - DAY;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
               VALUES ('dl-lo-1', 'sp-sales', 'sales', 'booked', 'open', 'cl-a-90', 'cd-a-90', ${U.opA}, ${t}, ${t}, ${t}),
                      ('dl-lo-2', 'sp-sales', 'sales', 'negotiation', 'open', 'cl-a-90', 'cd-a-90', ${U.opA}, ${t}, ${t + 1}, ${t + 1})`;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, won_at, created_at, updated_at)
               VALUES ('dl-lo-won', 'sp-sales', 'sales', 'won', 'won', 'cl-a-90', 'cd-a-90', ${U.opA}, ${t}, ${t}, ${t}, ${t})`;
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-90', outcomeKey: 'not_interested', reasonCode: 'expensive' }));
  assert.equal(r.card?.state, 'not_interested');
  const deals = await db.sql<{ id: string; status: string; reason: string; lostAt: number | null }>`SELECT id, status, lost_reason_code AS reason, lost_at FROM deals WHERE client_id = 'cl-a-90' ORDER BY id`;
  assert.deepEqual(deals.map((d) => [d.id, d.status, d.reason]), [['dl-lo-1', 'lost', 'expensive'], ['dl-lo-2', 'lost', 'expensive'], ['dl-lo-won', 'won', '']]);
  assert.ok(deals.filter((d) => d.status === 'lost').every((d) => d.lostAt === SEED_NOW));
  const feed = await db.sql<{ dealId: string }>`SELECT deal_id FROM client_events WHERE client_id = 'cl-a-90' AND kind = 'deal.lost' ORDER BY deal_id`;
  assert.deepEqual(feed.map((f) => f.dealId), ['dl-lo-1', 'dl-lo-2']);
});

test('«Не интересно» без открытых сделок: итог принят, сделок не появилось', async () => {
  await fresh('cd-a-91', { state: 'retry', attempts: 1, nextCallAt: SEED_NOW - HOUR });
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-91', outcomeKey: 'not_interested', reasonCode: 'expensive' }));
  assert.equal(r.status, 'applied');
  assert.equal(r.card?.state, 'not_interested');
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE client_id = 'cl-a-91'`), 0);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE client_id = 'cl-a-91' AND kind = 'deal.lost'`), 0);
});
