// Шапка карточки от доски (C4) и кнопка «Покупка» (C7): данные только при OP_BOARD, право — по охвату открытой сделки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientCard } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { SEED_NOW, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
  process.env['FEATURE_PURCHASES'] = '1';
});
after(async () => {
  delete process.env['FEATURE_PURCHASES'];
  await closeClientsWorld(db);
});

async function withBoard<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['FEATURE_OP_BOARD'];
  process.env['FEATURE_OP_BOARD'] = on ? '1' : '0';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['FEATURE_OP_BOARD'];
    else process.env['FEATURE_OP_BOARD'] = prev;
  }
}

test('перезвон «на день» с причиной и касанием: колонка, причина, явка и точность срока в шапке', async () => {
  const id = cardOf('a', 5);
  await db.sql`UPDATE cards SET state = 'callback', next_call_at = ${SEED_NOW + 86_400_000}, next_call_precision = 'day',
                      callback_reason = 'thinking', callback_touches = 2, attended_group_at = ${SEED_NOW - 1000}, purchases_total = 1
                WHERE id = ${id}`;
  const v = await viewerOf(U.opA);
  const head = (await withBoard(true, () => getClientCard(v, clientOf('a', 5)))).card;
  assert.ok(head?.board, 'доска включена: поля есть');
  assert.equal(head.board.column, 'callback');
  assert.equal(head.nextCallPrecision, 'day');
  assert.equal(head.board.callbackReason, 'thinking');
  assert.equal(head.board.callbackTouches, 2);
  assert.notEqual(head.board.attended.group, null);
  assert.equal(head.board.attended.individual, null);
  // У оператора есть deal.read или нет — «покупал» раскрывается только с правом; ключ обязан быть булевым
  assert.equal(typeof head.board.purchased, 'boolean');
});

test('доска выключена: поля шапки от доски нет, шапка прежняя', async () => {
  const v = await viewerOf(U.opA);
  const head = (await withBoard(false, () => getClientCard(v, clientOf('a', 5)))).card;
  assert.equal(head?.board, null);
});

test('чужой клиент — 404 (шапка не раскрывает карточку)', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(withBoard(true, () => getClientCard(v, clientOf('b', 5))), { code: 'not_found' });
});

test('«Покупка»: у РОП по открытой сделке — да; у директора и оператора — нет; без открытой сделки — нет', async () => {
  const client = clientOf('a', 1);
  const rop = await getClientCard(await viewerOf(U.rop), client);
  assert.equal(rop.can.purchase, true);
  assert.equal((await getClientCard(await viewerOf(U.director), client)).can.purchase, false);
  assert.equal((await getClientCard(await viewerOf(U.opA), client)).can.purchase, false);
  // карточка без открытой сделки
  assert.equal((await getClientCard(await viewerOf(U.rop), clientOf('a', 2))).can.purchase, false);
  // сделка закрыта — кнопки нет
  await db.sql`UPDATE deals SET status = 'won', won_at = ${SEED_NOW} WHERE id = 'dl-a-1'`;
  assert.equal((await getClientCard(await viewerOf(U.rop), client)).can.purchase, false);
  await db.sql`UPDATE deals SET status = 'open', won_at = NULL WHERE id = 'dl-a-1'`;
});

test('«Покупка» выключается флагом раздела покупок', async () => {
  process.env['FEATURE_PURCHASES'] = '0';
  try {
    assert.equal((await getClientCard(await viewerOf(U.rop), clientOf('a', 1))).can.purchase, false);
  } finally {
    process.env['FEATURE_PURCHASES'] = '1';
  }
});
