// Сервер доски (C5, pipeline-v2 §2.3, §6.2): порядок колонки «Перезвон» = эталон ядра, ключевая пагинация без дублей и
// пропусков при вставке во время листания, задержанные не на доске, поиск по своим, фильтры, доступ ролей, признаки покупок.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { calling } from '@crm/core';
import { BadRequestError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BOARD_PAGE, BOARD_SEARCH_LIMIT, getBoard, getBoardColumn, type BoardCardDto } from '../../../src/server/domain/cards/board';
import { configDoc } from '../../isolation/harness/config';
import { enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { DAY, HOUR, SEED_NOW, addCard, boundsNow, clearOwner, closeBoardWorld, lcg, openBoardWorld } from './boardWorld';

let db: TestDb;
let opA: Viewer;
let opB: Viewer;
let rop: Viewer;

before(async () => {
  db = await openBoardWorld();
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  rop = await viewerOf(U.rop);
  await clearOwner(db.sql, U.opA);
});
after(() => closeBoardWorld(db));

const column = (b: Awaited<ReturnType<typeof getBoard>>, key: string) => b.columns.find((c) => c.key === key)!;

/** Все страницы колонки «Ещё» по курсору. */
async function drain(v: Viewer, key: string, first: { cards: BoardCardDto[]; next: string | null }, onPage?: (n: number) => Promise<void>, filter: string[] = []): Promise<BoardCardDto[]> {
  const all = [...first.cards];
  let next = first.next;
  let n = 1;
  while (next) {
    if (onPage) await onPage(n);
    const p = await getBoardColumn(v, { column: key, cursor: next, filter });
    all.push(...p.cards);
    next = p.next;
    n++;
  }
  return all;
}

test('«Перезвон»: порядок SQL = compareForQueue ядра (огонёк → heat ↓ → срок ↑ → id), по страницам', async () => {
  const rnd = lcg(7);
  const bounds = await boundsNow();
  const heats = [0, 50, 100, 100, 300, 600];
  const times = [SEED_NOW - 3 * HOUR, SEED_NOW - 3 * HOUR, SEED_NOW + HOUR, SEED_NOW + 2 * DAY, SEED_NOW + 2 * DAY, null];
  const made: Array<{ id: string; heat: number; nextCallAt: number | null }> = [];
  for (let i = 0; i < 120; i++) {
    const heat = heats[Math.floor(rnd() * heats.length)]!;
    const nextCallAt = times[Math.floor(rnd() * times.length)] ?? null;
    const id = `ord-${String(i).padStart(3, '0')}`;
    made.push({ id, heat, nextCallAt });
    await addCard(db.sql, { id, owner: U.opA, state: i % 2 ? 'callback' : 'retry', heat, nextCallAt }, 100 + i);
  }
  const board = await getBoard(opA, {});
  const col = column(board, 'callback');
  assert.equal(col.cards.length, BOARD_PAGE);
  assert.ok(col.next);
  const got = (await drain(opA, 'callback', col)).map((c) => c.id);
  const expected = made.sort((a, b) => calling.compareForQueue({ ...a, nextCallPrecision: 'time' }, { ...b, nextCallPrecision: 'time' }, bounds)).map((m) => m.id);
  assert.deepEqual(got, expected);
  assert.equal(new Set(got).size, got.length, 'дублей нет');
});

test('«Ещё» по ключу: вставка во время листания не даёт ни дублей, ни пропусков', async () => {
  const first = column(await getBoard(opA, {}), 'callback');
  const firstIds = first.cards.map((c) => c.id);
  let seq = 0;
  const added: { above: string[]; below: string[] } = { above: [], below: [] };
  const all = await drain(opA, 'callback', first, async (n) => {
    if (n !== 1) return;
    // выше курсора (огонёк, максимальный heat) и ниже (через три дня, нулевой heat)
    for (let i = 0; i < 5; i++) {
      const hi = `ins-hi-${seq}`;
      const lo = `ins-lo-${seq}`;
      seq++;
      await addCard(db.sql, { id: hi, owner: U.opA, state: 'callback', heat: 900, nextCallAt: SEED_NOW - 4 * HOUR }, 400 + seq * 2);
      await addCard(db.sql, { id: lo, owner: U.opA, state: 'callback', heat: 0, nextCallAt: SEED_NOW + 3 * DAY }, 401 + seq * 2);
      added.above.push(hi);
      added.below.push(lo);
    }
  });
  const ids = all.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'дублей нет');
  assert.deepEqual(ids.slice(0, firstIds.length), firstIds, 'первая страница не сдвинулась');
  for (const id of added.above) assert.ok(!ids.includes(id), `${id} выше курсора: на следующих страницах не появляется`);
  for (const id of added.below) assert.ok(ids.includes(id), `${id} ниже курсора: подхвачена`);
  assert.equal(ids.filter((i) => i.startsWith('ord-')).length, 120, 'ни одна исходная карточка не потеряна');
});

test('задержанная и безвладельная «Новая» не на доске; поиск находит свою задержанную без колонки', async () => {
  await addCard(db.sql, { id: 'hold-1', owner: U.opA, state: 'new', holdReason: 'dup_pair', name: 'ТОО Синтетика Задержка', heat: 20 }, 600);
  await addCard(db.sql, { id: 'pool-1', owner: null, state: 'new', name: 'ТОО Синтетика Пул', heat: 20 }, 601);
  await addCard(db.sql, { id: 'new-1', owner: U.opA, state: 'new', name: 'ТОО Синтетика Новая', heat: 20 }, 602);
  const board = await getBoard(opA, { q: 'Синтетика Задержка' });
  const onBoard = board.columns.flatMap((c) => c.cards.map((x) => x.id));
  assert.ok(!onBoard.includes('hold-1') && !onBoard.includes('pool-1'));
  assert.deepEqual(column(board, 'new').cards.map((c) => c.id), ['new-1']);
  assert.deepEqual(board.search?.matches.map((m) => [m.id, m.column]), [['hold-1', null]]);
});

test('поиск: только свои, чужие не занимают лимит, короткий запрос не ищет', async () => {
  const r = await getBoard(opA, { q: 'синтетика' });
  assert.equal(r.search?.matches.length, BOARD_SEARCH_LIMIT);
  const owners = await db.sql<{ owner: string | null }>`SELECT owner_user_id AS owner FROM cards WHERE id = ANY(${r.search!.matches.map((m) => m.id)}::text[])`;
  assert.ok(owners.every((o) => o.owner === U.opA), 'в выдаче нет чужих');
  assert.deepEqual((await getBoard(opA, { q: 'Синтетика Бета 5' })).search?.matches, []);
  assert.deepEqual((await getBoard(opA, { q: '77091000005' })).search?.matches, []);
  assert.equal((await getBoard(opA, { q: 'аб' })).search?.short, true);
  assert.equal((await getBoard(opA, { q: '1234' })).search?.short, true);
  assert.ok((await getBoard(rop, { q: 'Синтетика Бета 5' })).search!.matches.length > 0, 'РОП видит всё пространство');
});

test('оператор A не видит карточки B ни в колонках, ни в «Ещё»', async () => {
  const board = await getBoard(opA, {});
  const ids = board.columns.flatMap((c) => c.cards.map((x) => x.id));
  assert.ok(ids.length > 0 && ids.every((i) => !i.startsWith('cd-b-')));
  const bBoard = await getBoard(opB, {});
  const bIds = bBoard.columns.flatMap((c) => c.cards.map((x) => x.id));
  assert.ok(bIds.length > 0 && bIds.every((i) => i.startsWith('cd-b-')));
  // курсор оператора A, подставленный оператором B, чужого не открывает
  const aCursor = column(board, 'callback').next!;
  const more = await getBoardColumn(opB, { column: 'callback', cursor: aCursor });
  assert.ok(more.cards.every((c) => c.id.startsWith('cd-b-')));
});

test('фильтры: owner у оператора — 400, у РОП работает; неизвестный фильтр, колонка и курсор — 400', async () => {
  await assert.rejects(getBoard(opA, { owner: U.opB }), (e: unknown) => e instanceof BadRequestError && e.detail === 'owner');
  await assert.rejects(getBoardColumn(opA, { column: 'callback', owner: U.opB }), BadRequestError);
  await assert.rejects(getBoard(opA, { filter: ['nope'] }), (e: unknown) => e instanceof BadRequestError && e.detail === 'filter');
  const b = await getBoard(rop, { owner: U.opB });
  const ids = b.columns.flatMap((c) => c.cards.map((x) => x.id));
  assert.ok(ids.length > 0 && ids.every((i) => i.startsWith('cd-b-')));
  await assert.rejects(getBoardColumn(opA, { column: 'нет-такой' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'column');
  await assert.rejects(getBoardColumn(opA, { column: 'callback', cursor: 'мусор' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'cursor');
});

test('фильтры признаков и «сегодня»', async () => {
  await db.sql`UPDATE cards SET attended_group_at = ${SEED_NOW - 5 * DAY} WHERE id IN ('ord-001','ord-003')`;
  await db.sql`UPDATE cards SET last_no_show_at = ${SEED_NOW - DAY}, last_no_show_kind = 'group' WHERE id IN ('ord-003','ord-005')`;
  await db.sql`UPDATE cards SET purchases_total = 1, last_purchase_at = ${SEED_NOW - 9 * DAY} WHERE id = 'ord-007'`;
  const ids = async (filter: string[]) => {
    const c = column(await getBoard(opA, { filter }), 'callback');
    return (await drain(opA, 'callback', c, undefined, filter)).map((x) => x.id).filter((i) => i.startsWith('ord-'));
  };
  assert.deepEqual((await ids(['attendedGroup'])).sort(), ['ord-001', 'ord-003']);
  // неявка считается, если она позже последней явки: у ord-003 явка раньше неявки
  assert.deepEqual((await ids(['noShow'])).sort(), ['ord-003', 'ord-005']);
  assert.deepEqual(await ids(['purchased']), ['ord-007']);
  const today = await ids(['today']);
  const times = await db.sql<{ id: string; nextCallAt: number | null }>`SELECT id, next_call_at FROM cards WHERE id = ANY(${today}::text[])`;
  const b = await boundsNow();
  assert.ok(times.length > 0 && times.every((t) => t.nextCallAt !== null && t.nextCallAt < b.tomorrowStart));
});

test('доступ: директор читает; консультант и отдел передачи — 404; выключенный OP_BOARD — 404', async () => {
  const dir = await viewerOf(U.director);
  assert.ok((await getBoard(dir, {})).canFilterOwner);
  for (const u of [U.consultant, U.marketer, U.mktHead]) {
    const v = await viewerOf(u);
    await assert.rejects(getBoard(v, {}), NotFoundError, u);
    await assert.rejects(getBoardColumn(v, { column: 'callback' }), NotFoundError, u);
  }
  const prev = process.env['FEATURE_OP_BOARD'];
  process.env['FEATURE_OP_BOARD'] = '0';
  try {
    await assert.rejects(getBoard(opA, {}), NotFoundError);
    await assert.rejects(getBoardColumn(opA, { column: 'callback' }), NotFoundError);
  } finally {
    if (prev === undefined) delete process.env['FEATURE_OP_BOARD'];
    else process.env['FEATURE_OP_BOARD'] = prev;
  }
});

test('признаки покупок: есть при deal.read роли, у роли без него ключа нет вовсе', async () => {
  const first = column(await getBoard(opA, { filter: ['purchased'] }), 'callback');
  const withBuy = (await drain(opA, 'callback', first, undefined, ['purchased'])).find((c) => c.id === 'ord-007');
  assert.deepEqual(withBuy?.purchases, { total: 1, lastAt: SEED_NOW - 9 * DAY });
  // та же роль оператора, но без deal.read: ключа purchases нет, фильтр purchased — 400
  const doc = configDoc() as { global: { roles: Array<{ key: string; grants: Array<{ perm: string }> }> } };
  const roles = doc.global.roles.map((r) => (r.key === 'operator' ? { ...r, grants: r.grants.filter((g) => g.perm !== 'deal.read') } : r));
  enterSeedWorld({ config: { ...doc, global: { ...doc.global, roles } } });
  try {
    const v = await viewerOf(U.opA);
    const cards = (await getBoard(v, {})).columns.flatMap((c) => c.cards);
    assert.ok(cards.length > 0 && cards.every((c) => !('purchases' in c)));
    assert.ok(!JSON.stringify(cards).includes('lastAt'));
    await assert.rejects(getBoard(v, { filter: ['purchased'] }), (e: unknown) => e instanceof BadRequestError && e.detail === 'filter');
  } finally {
    enterSeedWorld();
  }
});

test('«Покупка» и «Мусор»: порядок по last_purchase_at ↓ и closed_at ↓, окно recentDays', async () => {
  for (let i = 0; i < 5; i++) await addCard(db.sql, { id: `buy-${i}`, owner: U.opA, state: 'client', lastPurchaseAt: SEED_NOW - (i + 1) * DAY, purchasesTotal: 1 }, 700 + i);
  await addCard(db.sql, { id: 'trash-new', owner: U.opA, state: 'not_target', closedAt: SEED_NOW - 2 * DAY }, 710);
  await addCard(db.sql, { id: 'trash-mid', owner: U.opA, state: 'do_not_call', closedAt: SEED_NOW - 10 * DAY }, 711);
  await addCard(db.sql, { id: 'trash-old', owner: U.opA, state: 'written_off', closedAt: SEED_NOW - 40 * DAY, name: 'ТОО Синтетика Архивная' }, 712);
  const b = await getBoard(opA, {});
  assert.deepEqual(column(b, 'purchase').cards.map((c) => c.id), ['buy-0', 'buy-1', 'buy-2', 'buy-3', 'buy-4']);
  assert.deepEqual(column(b, 'trash').cards.map((c) => c.id), ['trash-new', 'trash-mid']);
  // старый — только через поиск
  const s = await getBoard(opA, { q: 'синтетика архивная' });
  assert.deepEqual(s.search?.matches.map((m) => [m.id, m.column]), [['trash-old', 'trash']]);
});

test('«Бизнес-разбор» и «Консультация»: запись открытой сделки решает колонку, без записи — запасная колонка', async () => {
  const t = SEED_NOW - DAY;
  const mk = async (id: string, seq: number, booking: { type: string; startsAt: number; status?: string } | null) => {
    await addCard(db.sql, { id, owner: U.opA, state: 'agreed' }, 800 + seq);
    await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
                 VALUES (${`dl-${id}`}, 'sp-sales', 'sales', 'booked', 'open', ${`cl-${id}`}, ${id}, ${U.opA}, ${t}, ${t}, ${t})`;
    if (booking) {
      const group = booking.type !== 'bk';
      await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, status, created_at, updated_at)
                   VALUES (${`bk-${id}`}, 'sp-sales', ${group ? 'group' : 'individual'}, ${booking.type}, ${group ? 'ev-today' : null}, ${group ? null : 'rs-cons'},
                           ${`cl-${id}`}, ${id}, ${`dl-${id}`}, '2026-11-02', '10:00', ${booking.startsAt}, 60, ${booking.status ?? 'registered'}, ${t}, ${t})`;
    }
  };
  await mk('ag-br-2', 1, { type: 'br', startsAt: SEED_NOW + 3 * DAY });
  await mk('ag-br-1', 2, { type: 'br', startsAt: SEED_NOW + 2 * DAY });
  await mk('ag-bk-2', 3, { type: 'bk', startsAt: SEED_NOW + 6 * DAY });
  await mk('ag-bk-1', 4, { type: 'bk', startsAt: SEED_NOW + 5 * DAY });
  await mk('ag-none', 5, null);
  await mk('ag-cancelled', 6, { type: 'bk', startsAt: SEED_NOW + DAY, status: 'cancelled' });
  const b = await getBoard(opA, {});
  assert.deepEqual(column(b, 'bk').cards.map((c) => c.id), ['ag-bk-1', 'ag-bk-2'], 'по дате консультации ↑');
  // br: вид br, а также agreed без подходящей записи (запасная колонка); у «с записью» сперва по дате ↑, без записи — в конце
  assert.deepEqual(column(b, 'br').cards.map((c) => c.id), ['ag-br-1', 'ag-br-2', 'ag-cancelled', 'ag-none']);
  assert.equal(column(b, 'bk').cards[0]!.event?.type, 'bk');
});

test('«Новые»: горячесть → мобильные раньше → выдача; у охвата шире своего мобильные не различаются (цена на 300 000)', async () => {
  const t = SEED_NOW - DAY;
  const mk = async (id: string, seq: number, heat: number, assignedAt: number, kind: 'mobile' | 'landline') => {
    await addCard(db.sql, { id, owner: U.opA, state: 'new', heat, assignedAt }, 1000 + seq);
    await db.sql`UPDATE client_phones SET kind = ${kind} WHERE id = ${`ph-${id}`}`;
  };
  await mk('nw-land-early', 1, 220, t, 'landline');
  await mk('nw-mob-late', 2, 220, t + 5 * HOUR, 'mobile');
  await mk('nw-mob-early', 3, 220, t + HOUR, 'mobile');
  await mk('nw-cold', 4, 20, t - HOUR, 'mobile');
  const mine = column(await getBoard(opA, {}), 'new').cards.map((c) => c.id).filter((i) => i.startsWith('nw-'));
  assert.deepEqual(mine, ['nw-mob-early', 'nw-mob-late', 'nw-land-early', 'nw-cold']);
  const wide = column(await getBoard(rop, { owner: U.opA }), 'new').cards.map((c) => c.id).filter((i) => i.startsWith('nw-'));
  assert.deepEqual(wide, ['nw-land-early', 'nw-mob-early', 'nw-mob-late', 'nw-cold']);
});
