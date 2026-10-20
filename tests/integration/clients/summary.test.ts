// Итоговый отчёт по клиенту (C8 §3.4): структура без текста, только видимое зрителю; следующий шаг по приоритету.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientSummaryFor } from '../../../src/server/domain/clients';
import { NotFoundError } from '../../../src/server/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { FX, SEED_NOW, SPACE, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const HOUR = 3_600_000;

async function addCall(id: string, who: 'a' | 'b', i: number, at: number, lpr: '' | 'yes' = '') {
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, lpr,
                                  applied, occurred_at, received_at, config_rev)
               VALUES (${id}, ${SPACE}, ${cardOf(who, i)}, ${clientOf(who, i)}, ${who === 'a' ? U.opA : U.opB}, 'ui', '77090000000',
                       'no_answer', 'no_answer', ${lpr}, 'applied', ${at}, ${at}, 1)`;
}

test('период, ЛПР, счётчики карточки, покупки и владелец собираются из данных зрителя', async () => {
  const i = 40;
  await db.sql`UPDATE cards SET calls_total = 4, connects_total = 2, no_answer_total = 2 WHERE id = ${cardOf('a', i)}`;
  await addCall('sm-c1', 'a', i, SEED_NOW - 10 * HOUR);
  await addCall('sm-c2', 'a', i, SEED_NOW - 5 * HOUR, 'yes');
  await addCall('sm-c3', 'a', i, SEED_NOW - 2 * HOUR, 'yes');
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key,
                                  amount_kzt, won_at, stage_changed_at, created_by, created_at, updated_at)
               VALUES ('sm-d1', ${SPACE}, 'sales', 'won', 'won', ${clientOf('a', i)}, ${cardOf('a', i)}, ${U.opA}, 'smm', 450000,
                       ${SEED_NOW - HOUR}, ${SEED_NOW}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
  const s = await getClientSummaryFor(await viewerOf(U.opA), clientOf('a', i));
  assert.deepEqual(s.period, { from: SEED_NOW - 10 * HOUR, to: SEED_NOW - 2 * HOUR });
  assert.equal(s.lprFoundAt, SEED_NOW - 5 * HOUR);
  assert.deepEqual(s.calls, { total: 4, connects: 2, noAnswer: 2 });
  assert.deepEqual(s.purchases, [{ serviceTypeKey: 'smm', amountKzt: 450000, wonAt: SEED_NOW - HOUR }]);
  assert.equal(s.ownerName, 'Оператор Синтетик А');
  assert.equal(s.actingName, null);
});

test('следующий шаг: перезвон по next_call_at важнее записи, запись важнее задачи, иначе «нет»', async () => {
  const v = await viewerOf(U.opA);
  // a-41: состояние «перезвонить» — шаг callback
  await db.sql`UPDATE cards SET state = 'callback', next_call_at = ${SEED_NOW + 3 * HOUR} WHERE id = ${cardOf('a', 41)}`;
  assert.deepEqual((await getClientSummaryFor(v, clientOf('a', 41))).nextStep, { kind: 'callback', at: SEED_NOW + 3 * HOUR });
  // a-42: состояние «клиент» с будущей записью и открытой задачей — шаг booking
  await db.sql`UPDATE cards SET state = 'client' WHERE id = ${cardOf('a', 42)}`;
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time, starts_at,
                                     duration_min, status, booked_by_user_id, responsible_user_id, created_at, updated_at)
               VALUES ('sm-b1', ${SPACE}, 'individual', 'consult', 'rs-cons', ${clientOf('a', 42)}, ${cardOf('a', 42)}, '2026-10-30', '11:00',
                       ${SEED_NOW + 48 * HOUR}, 60, 'registered', ${U.opA}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, created_at)
               VALUES ('sm-t42', ${SPACE}, ${clientOf('a', 42)}, 'call', 'manual', 'Позвонить', ${SEED_NOW + HOUR}, ${U.opA}, ${SEED_NOW})`;
  const s42 = await getClientSummaryFor(v, clientOf('a', 42));
  assert.deepEqual(s42.nextStep, { kind: 'booking', at: SEED_NOW + 48 * HOUR });
  assert.equal(s42.bookings.length, 1);
  assert.equal(s42.bookings[0]?.status, 'registered');
  assert.equal(s42.bookings[0]?.consultantName, 'Консультант Синтетик');
  // a-43: только задача
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, created_at)
               VALUES ('sm-t43', ${SPACE}, ${clientOf('a', 43)}, 'call', 'manual', 'Позвонить', ${SEED_NOW + HOUR}, ${U.opA}, ${SEED_NOW})`;
  assert.deepEqual((await getClientSummaryFor(v, clientOf('a', 43))).nextStep, { kind: 'task', at: SEED_NOW + HOUR, taskSource: 'manual' });
  // a-44: ничего (в пуле нет ни задачи, ни записи)
  assert.deepEqual((await getClientSummaryFor(v, clientOf('a', 44))).nextStep, { kind: 'none', at: null });
});

test('перенесённая запись в отчёт не попадает; записей не больше десяти', async () => {
  const v = await viewerOf(U.opA);
  const i = 45;
  for (let k = 0; k < 12; k++) {
    await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time, starts_at,
                                       duration_min, status, booked_by_user_id, responsible_user_id, created_at, updated_at)
                 VALUES (${`sm-m${k}`}, ${SPACE}, 'individual', 'consult', 'rs-cons', ${clientOf('a', i)}, ${cardOf('a', i)}, '2026-09-01', '11:00',
                         ${SEED_NOW - (k + 1) * 24 * HOUR}, 60, ${k === 0 ? 'moved' : 'attended'}, ${U.opA}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
  }
  const s = await getClientSummaryFor(v, clientOf('a', i));
  assert.equal(s.bookings.length, 10);
  assert.ok(s.bookings.every((b) => b.status !== 'moved'));
});

test('оператор не видит чужие записи и передачи; РОП видит передачу клиента', async () => {
  // Клиент оператора A с передачей отделу: права `handoff.read` у оператора нет, у РОП есть
  const i = 46;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, won_at, stage_changed_at,
                                  created_by, created_at, updated_at)
               VALUES ('sm-hd', ${SPACE}, 'sales', 'won', 'won', ${clientOf('a', i)}, ${cardOf('a', i)}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW},
                       ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, assignee_user_id, due_at, created_at)
               VALUES ('sm-ho', ${SPACE}, ${SPACE}, 'team-mkt', 'sm-hd', ${clientOf('a', i)}, 'pending', ${U.marketer}, ${SEED_NOW + HOUR}, ${SEED_NOW})`;
  const op = await getClientSummaryFor(await viewerOf(U.opA), clientOf('a', i));
  const rop = await getClientSummaryFor(await viewerOf(U.rop), clientOf('a', i));
  assert.deepEqual(op.handoffs, []);
  assert.equal(rop.handoffs.length, 1);
  assert.equal(rop.handoffs[0]?.teamKey, 'marketing');
  assert.equal(rop.handoffs[0]?.status, 'pending');
});

test('консультант видит в отчёте только свои записи клиента; чужой клиент — 404', async () => {
  // Клиент B2: запись у консультанта в окне. Оператор A клиента B не видит вовсе
  const a = await viewerOf(U.opA);
  await assert.rejects(() => getClientSummaryFor(a, FX.bkInWindow.client), NotFoundError);
  const cons = await viewerOf(U.consultant);
  const s = await getClientSummaryFor(cons, FX.bkInWindow.client);
  assert.deepEqual(s.bookings.map((b) => b.date), [FX.bkInWindow.date]);
  assert.deepEqual(s.purchases, []);
});

