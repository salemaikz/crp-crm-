// Обзвон «подтвердить явку» на доске (D-355, pv2-round3 §1): пометка, порядок `(part, k2, k1, id)`, «Ещё» без потерь,
// окно по местному дню, confirmedBy только при охвате шире своих, summary с фильтром владельца, флаги.
// now = чт 29.10.2026 10:00 по Алматы; БР в чт 15:00 — ближайшее мероприятие. Синтетика +7 709 …
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { POST as confirmPost } from '../../../src/app/api/bookings/[id]/confirm/route';
import { getBoard, getBoardColumn, BOARD_PAGE, type BoardCardDto } from '../../../src/server/domain/cards/board';
import { parseBoardSettings } from '../../../src/server/domain/cards/boardSettings';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { actAs, enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import { callsDeps, outcomeReq } from '../calls/world';
import { seedBookings, seedEvent } from '../booking/helpers';
import { seedDeal } from '../deals/helpers';
import { addCard, clearOwner, closeBoardWorld, openBoardWorld } from './boardWorld';

const MIN = 60_000;
/** Чт 29.10.2026 10:00 по Алматы (UTC+5) и пт 30.10 10:00. */
const THU = Date.UTC(2026, 9, 29, 5, 0);
const FRI = Date.UTC(2026, 9, 30, 5, 0);
const clock = { now: THU };

let db: TestDb;
const ORIGIN = 'http://crm.test';

async function viewerAt(userId: string, now: number): Promise<Viewer> {
  enterSeedWorld({ now });
  return viewerOf(userId);
}

/** Карточка «Договорились» с открытой сделкой и записью на мероприятие (по умолчанию `registered`). */
async function agree(id: string, owner: string, event: string, seq: number, status: 'registered' | 'confirmed' = 'registered'): Promise<string> {
  await addCard(db.sql, { id, owner, state: 'agreed', name: `ТОО Синтетика Явка ${id}` }, 3000 + seq);
  await seedDeal(db.sql, { id: `dl-${id}`, client: `cl-${id}`, card: id, stage: 'booked', owner });
  const [b] = await seedBookings(db.sql, event, [{ client: `cl-${id}`, card: id }], { bookedBy: owner, status });
  await db.sql`UPDATE bookings SET deal_id = ${`dl-${id}`} WHERE id = ${b!}`;
  return b!;
}

const all = (b: Awaited<ReturnType<typeof getBoard>>): BoardCardDto[] => b.columns.flatMap((c) => c.cards);
const find = (b: Awaited<ReturnType<typeof getBoard>>, id: string) => all(b).find((c) => c.id === id);
/** Колонка, в которой лежит карточка, и порядок её id. */
const colOf = (b: Awaited<ReturnType<typeof getBoard>>, id: string) => b.columns.find((c) => c.cards.some((x) => x.id === id))!;

async function noAnswer(userId: string, cardId: string, at: number): Promise<void> {
  const r = await submitOutcome(callsDeps(clock), await viewerAt(userId, THU), outcomeReq({ cardId, occurredAt: at }));
  assert.ok(r.status === 'applied' || r.status === 'fact_only', `итог записан: ${r.status}`);
}

before(async () => {
  db = await openBoardWorld();
  await clearOwner(db.sql, U.opA);
  await clearOwner(db.sql, U.opB);
  await seedEvent(db.sql, { id: 'ev-wed', date: '2026-10-28', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-thu09', date: '2026-10-29', time: '09:00' });
  await seedEvent(db.sql, { id: 'ev-thu15', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-next', date: '2026-11-05', time: '15:00' });
  await agree('cf-todo1', U.opA, 'ev-thu15', 1);
  await agree('cf-todo2', U.opA, 'ev-thu15', 2);
  await agree('cf-next', U.opA, 'ev-next', 3);
  await agree('cf-started', U.opA, 'ev-thu09', 4);
  await agree('cf-old', U.opA, 'ev-wed', 5);
  await agree('cf-b1', U.opB, 'ev-thu15', 6);
});
after(() => closeBoardWorld(db));

test('четверг: записанные на ближайший БР — сверху с пометкой todo, остальные без пометки в прежнем порядке', async () => {
  const b = await getBoard(await viewerAt(U.opA, THU), {});
  assert.equal(b.confirm?.day, '2026-10-29');
  assert.deepEqual(b.confirm?.events, [{ type: 'br', date: '2026-10-29' }]);
  assert.equal(b.confirm?.declineReason, 'wont_come_br');
  assert.deepEqual(b.confirm?.summary, { todo: 2, tried: 0, confirmed: 0 });
  const col = colOf(b, 'cf-todo1');
  assert.deepEqual(col.cards.map((c) => c.id), ['cf-todo1', 'cf-todo2', 'cf-old', 'cf-started', 'cf-next']);
  assert.deepEqual(find(b, 'cf-todo1')?.confirm, { mark: 'todo', tries: 0, lastTryAt: null, confirmedAt: null });
  for (const id of ['cf-next', 'cf-started', 'cf-old']) assert.equal('confirm' in find(b, id)!, false, `${id}: без пометки`);
  assert.equal(find(b, 'cf-b1'), undefined, 'чужая карточка оператору не видна');
});

test('недозвон: итог «Не берёт» ложится фактом, карточка остаётся, пометка tried и ниже todo', async () => {
  await noAnswer(U.opA, 'cf-todo1', THU - 30 * MIN);
  const b = await getBoard(await viewerAt(U.opA, THU), {});
  const col = colOf(b, 'cf-todo1');
  assert.deepEqual(col.cards.slice(0, 2).map((c) => c.id), ['cf-todo2', 'cf-todo1']);
  assert.equal(find(b, 'cf-todo1')?.state, 'agreed');
  assert.deepEqual(find(b, 'cf-todo1')?.confirm, { mark: 'tried', tries: 1, lastTryAt: THU - 30 * MIN, confirmedAt: null });
  assert.equal(find(b, 'cf-todo2')?.confirm?.mark, 'todo');
  assert.deepEqual(b.confirm?.summary, { todo: 1, tried: 1, confirmed: 0 });
});

test('«Придёт»: confirmed при любых недозвонах; confirmedBy есть у РОП, у оператора ключа нет', async () => {
  const bookingId = (await db.sql<{ id: string; version: number }>`SELECT id, version FROM bookings WHERE card_id = 'cf-todo1'`)[0]!;
  actAs(U.rop);
  const res = await confirmPost(
    new Request(`${ORIGIN}/api/bookings/${bookingId.id}/confirm`, { method: 'POST', headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ opId: crypto.randomUUID(), version: bookingId.version, to: 'confirmed' }) }),
    { params: Promise.resolve({ id: bookingId.id }) },
  );
  assert.equal(res.status, 200);
  const [rop] = await db.sql<{ name: string }>`SELECT name FROM users WHERE id = ${U.rop}`;

  const asOp = find(await getBoard(await viewerAt(U.opA, THU), {}), 'cf-todo1')!;
  assert.equal(asOp.confirm?.mark, 'confirmed');
  assert.equal(asOp.confirm?.tries, 1, 'недозвон не теряется, но пометка — confirmed');
  assert.equal(typeof asOp.confirm?.confirmedAt, 'number');
  assert.equal('confirmedBy' in asOp.confirm!, false, 'у оператора имени подтвердившего нет');

  const bRop = await getBoard(await viewerAt(U.rop, THU), {});
  assert.equal(find(bRop, 'cf-todo1')?.confirm?.confirmedBy, rop!.name);
  assert.deepEqual(bRop.confirm?.summary, { todo: 2, tried: 0, confirmed: 1 }, 'РОП: todo2 и b1, придёт — todo1');
  // confirmed уходит из верхней части: ниже обеих карточек без ответа
  const ids = colOf(bRop, 'cf-todo2').cards.map((c) => c.id);
  assert.ok(ids.indexOf('cf-todo1') > Math.max(ids.indexOf('cf-todo2'), ids.indexOf('cf-b1')));
});

test('фильтр confirm: в колонке записи только кандидаты, остальные колонки пусты; фильтр owner сужает summary', async () => {
  const rop = await viewerAt(U.rop, THU);
  const b = await getBoard(rop, { filter: ['confirm'] });
  assert.deepEqual(colOf(b, 'cf-todo2').cards.map((c) => c.id).sort(), ['cf-b1', 'cf-todo1', 'cf-todo2']);
  assert.equal(all(b).every((c) => c.confirm !== undefined), true);
  const own = await getBoard(rop, { owner: U.opB });
  assert.deepEqual(own.confirm?.summary, { todo: 1, tried: 0, confirmed: 0 });
  const opA = await getBoard(rop, { owner: U.opA });
  assert.deepEqual(opA.confirm?.summary, { todo: 1, tried: 0, confirmed: 1 });
});

test('пятница: окна нет — ключа confirm нет, порядок равен кругу 2 (дата записи ↑, id), фильтр молча отброшен', async () => {
  const fri = await viewerAt(U.opA, FRI);
  const plain = await getBoard(fri, {});
  assert.equal('confirm' in plain, false);
  assert.equal(all(plain).some((c) => 'confirm' in c), false);
  const col = colOf(plain, 'cf-old');
  const expected = await db.sql<{ id: string }>`
    SELECT c.id FROM cards c JOIN deals d ON d.card_id = c.id JOIN bookings b ON b.deal_id = d.id
     WHERE c.id = ANY(${col.cards.map((c) => c.id)}::text[]) ORDER BY b.starts_at, c.id`;
  assert.deepEqual(col.cards.map((c) => c.id), expected.map((r) => r.id));
  const filtered = await getBoard(fri, { filter: ['confirm'] });
  assert.deepEqual(colOf(filtered, 'cf-old').cards.map((c) => c.id), col.cards.map((c) => c.id), 'вне окна фильтр не сужает');
});

test('без CALLBACK_V2 ключей обзвона нет ни на доске, ни на плитках', async () => {
  process.env['FEATURE_CALLBACK_V2'] = '0';
  try {
    const b = await getBoard(await viewerAt(U.opA, THU), {});
    assert.equal('confirm' in b, false);
    assert.equal(all(b).some((c) => 'confirm' in c), false);
  } finally {
    process.env['FEATURE_CALLBACK_V2'] = '1';
  }
});

test('«Ещё» на границе частей: 50 карточек обзвона, затем остальные — без потерь и дублей', async () => {
  await clearOwner(db.sql, U.opA);
  await clearOwner(db.sql, U.opB);
  const ids: string[] = [];
  for (let i = 0; i < BOARD_PAGE; i++) {
    const id = `cp-${String(i).padStart(2, '0')}`;
    ids.push(id);
    await agree(id, U.opA, 'ev-thu15', 100 + i);
  }
  const rest = ['cp-r1', 'cp-r2', 'cp-r3'];
  for (const [i, id] of rest.entries()) await agree(id, U.opA, 'ev-wed', 200 + i);
  // три недозвона: попадают в часть 0 после todo, в порядке времени
  const tried = ['cp-07', 'cp-03', 'cp-20'];
  for (const [i, id] of tried.entries()) await noAnswer(U.opA, id, THU - (60 - i * 10) * MIN);

  const v = await viewerAt(U.opA, THU);
  const first = await getBoard(v, {});
  const col = colOf(first, 'cp-00');
  assert.equal(col.cards.length, BOARD_PAGE);
  assert.ok(col.next, 'есть «Ещё»');
  const second = await getBoardColumn(v, { column: col.key, cursor: col.next });
  assert.equal(second.next, null);
  const seen = [...col.cards, ...second.cards].map((c) => c.id);
  assert.equal(new Set(seen).size, seen.length, 'дублей нет');
  const todo = ids.filter((id) => !tried.includes(id));
  assert.deepEqual(seen, [...todo, ...tried, ...rest], 'todo по id, затем tried по времени недозвона, затем остальные по дате записи');
});

test('настройки: вид individual в confirmCall пропускается с invalid-setting; не осталось видов — обзвона нет', () => {
  const doc = (types: string[]) => ({
    booking: {
      eventTypes: [
        { key: 'br', behavior: 'group' },
        { key: 'bk', behavior: 'individual' },
      ],
      confirmCall: { eventTypes: types, weekdays: [4], declineReason: 'wont_come_br' },
    },
  });
  const mixed = parseBoardSettings(doc(['br', 'bk']));
  assert.deepEqual(mixed.confirmCall, { eventTypes: ['br'], weekdays: [4], declineReason: 'wont_come_br' });
  assert.deepEqual(mixed.warnings, ['invalid-setting']);
  const only = parseBoardSettings(doc(['bk']));
  assert.equal(only.confirmCall, null);
  assert.deepEqual(only.warnings, ['invalid-setting']);
  assert.equal(parseBoardSettings({}).confirmCall, null);
});
