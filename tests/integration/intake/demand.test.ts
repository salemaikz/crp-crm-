/* eslint-disable @typescript-eslint/no-explicit-any -- ответы API и строки БД в тестах читаются по путям */
// GET demand: формула needToday / needNext / needTotal по рабочему календарю, участникам раздачи, пулу и возвратам.
// Среда 2026-10-21, пояс UTC, 3 оператора, лимит 40; раздача по расписанию 08:00–18:00 каждый час.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { authenticateKey } from '../../../src/server/domain/intake/auth';
import { demandFor } from '../../../src/server/domain/intake/demand';
import { newId } from '../../../src/server/platform/db';
import { getDemand, installIntakeConfig, mkKey, mkMember, mkUser, spaceIdOf, T0 } from './helpers';

let db: TestDb;
let space: string;
let principal: Awaited<ReturnType<typeof authenticateKey>>;
const HOUR = 3_600_000;

async function card(state: string, o: { returnAt?: number; owner?: string } = {}): Promise<string> {
  const clientId = newId();
  const id = newId();
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at) VALUES (${clientId}, 'company', 'Синтетика', 'синтетика', 'manual', ${T0}, ${T0})`;
  await db.sql`
    INSERT INTO cards (id, space_id, client_id, state, owner_user_id, return_at, created_at, updated_at)
    VALUES (${id}, ${space}, ${clientId}, ${state}, ${o.owner ?? null}, ${o.returnAt ?? null}, ${T0}, ${T0})`;
  return id;
}

before(async () => {
  db = await createTestDb();
  await installIntakeConfig();
  space = await spaceIdOf(db);
  const [a, b, c, outsider] = [await mkUser(db, 1), await mkUser(db, 2), await mkUser(db, 3), await mkUser(db, 4)];
  await mkMember(db, a, space);
  await mkMember(db, b, space, { pausedOn: '2026-10-21' }); // «Пауза» сегодня
  await mkMember(db, c, space);
  await mkMember(db, outsider, space, { role: 'lead' }); // роль не из participantRoles
  // «Отсутствует» c в пятницу 23-го
  await db.sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, created_at) VALUES (${newId()}, ${space}, ${c}, '2026-10-23', '2026-10-23', ${T0})`;
  // 30 карточек в пуле, 5 с задержкой (не готовы), 1 в работе
  for (let i = 0; i < 30; i++) await card('new');
  const held = await card('new');
  await db.sql`UPDATE cards SET hold_reason = 'dup_pair' WHERE id = ${held}`;
  const worked = await card('callback', { owner: a });
  // выдано сегодня 20 (входит в лимит) + 5 не входит + 3 вчера
  for (let i = 0; i < 28; i++) {
    const day = i < 25 ? '2026-10-21' : '2026-10-20';
    await db.sql`
      INSERT INTO assign_log (id, space_id, card_id, to_user_id, kind, counts_to_cap, day, created_at)
      VALUES (${newId()}, ${space}, ${worked}, ${a}, 'auto', ${i < 20 || i >= 25}, ${day}, ${T0})`;
  }
  // возвраты: 5 сегодня, 2 завтра, 1 за горизонтом
  for (let i = 0; i < 5; i++) await card('not_interested', { returnAt: T0 + 3 * HOUR });
  for (let i = 0; i < 2; i++) await card('not_interested', { returnAt: T0 + 27 * HOUR });
  await card('not_interested', { returnAt: T0 + 40 * 24 * HOUR });
  principal = await authenticateKey(`Bearer ${(await mkKey('open')).key}`, 'leads:demand', 'test', T0);
});
after(async () => {
  await db.close();
});

test('утро рабочего дня: потребность считается от остатка лимита сегодня', async () => {
  const d = await demandFor(principal, T0);
  assert.equal(d.timezone, 'UTC');
  assert.equal(d.maxBatch, 1000);
  assert.equal(d.horizonWorkdays, 7);
  assert.equal(d.accepting, true);
  // сегодня: работают a и c (b на паузе, lead не в участниках); лимит 2 × 40, выдано 20 → осталось 60
  assert.deepEqual(d.today, { date: '2026-10-21', isWorkday: true, operators: 2, capPerOperator: 40, capacity: 80, issued: 20, remaining: 60 });
  assert.equal(d.poolReady, 30, 'карточка с задержкой и карточка в работе в пул не входят');
  assert.equal(d.needToday, 30);
  assert.deepEqual(d.days.map((x) => [x.date, x.operators, x.capacity]), [
    ['2026-10-22', 3, 120],
    ['2026-10-23', 2, 80], // c отсутствует
    ['2026-10-26', 3, 120],
    ['2026-10-27', 3, 120],
    ['2026-10-28', 3, 120],
    ['2026-10-29', 3, 120],
    ['2026-10-30', 3, 120],
  ]);
  assert.equal(d.returnsExpected, 7, 'возврат через 40 дней за горизонтом');
  // ближайший рабочий день — сегодня (раздача до 18:00 ещё не закончилась)
  assert.deepEqual(d.next, { date: '2026-10-21', capacity: 60, returnsDue: 5 });
  assert.equal(d.bufferDays, 0.5);
  assert.equal(d.needNext, Math.ceil(60 * 1.5) - 5 - 30);
  assert.equal(d.needTotal, 60 + (120 * 6 + 80) - 7 - 30);
});

test('вечером после раздачи ближайший рабочий день — завтра', async () => {
  const d = await demandFor(principal, T0 + 10 * HOUR); // 19:00
  assert.deepEqual(d.next, { date: '2026-10-22', capacity: 120, returnsDue: 7 });
  assert.equal(d.needNext, Math.ceil(120 * 1.5) - 7 - 30);
  assert.equal(d.needToday, 30);
});

test('выходной: needToday = 0, ближайший день — понедельник', async () => {
  const sat = Date.UTC(2026, 9, 24, 10, 0, 0);
  const d = await demandFor(principal, sat);
  assert.equal(d.today.isWorkday, false);
  assert.equal(d.today.operators, 0);
  assert.equal(d.needToday, 0);
  assert.equal(d.next?.date, '2026-10-26');
  assert.equal(d.needNext, Math.ceil(120 * 1.5) - 7 - 30);
});

test('HTTP: только числа, даты и признаки; пул заполнен — потребность падает до нуля', async () => {
  const res = await getDemand((await mkKey('open', ['leads:demand'])).key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body: any = await res.json();
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body);
  assert.ok(strings.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || s === 'UTC'), `лишние строки: ${strings.join(', ')}`);
  for (const k of ['asOf', 'accepting', 'maxBatch', 'horizonWorkdays', 'today', 'days', 'returnsExpected', 'poolReady', 'needToday', 'next', 'bufferDays', 'needNext', 'needTotal']) assert.ok(k in body, k);
  for (let i = 0; i < 200; i++) await card('new');
  const full: any = await (await getDemand((await mkKey('open', ['leads:demand'])).key)).json();
  assert.equal(full.needToday, 0);
  assert.equal(full.needNext, 0);
});
