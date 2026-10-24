// Шапка карточки от доски (C4) и кнопка «Покупка» (C7): данные только при OP_BOARD, право — по охвату открытой сделки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientCard, loadFeedCatalog } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { FX, SEED_NOW, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { closeClientsWorld, openClientsWorld, worldConfig } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
  // Доска стенда клиента из пресета: подписи колонок и тона берутся оттуда, а не из заглушки мира
  const preset = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'presets', 'clients', 'crp', 'preset.json'), 'utf8')) as {
    spaces: { sales: { board: { columns: Array<{ key: string; label: unknown; states: string[] }>; tones: unknown } } };
  };
  const docs = worldConfig();
  // Подписи и тона — как в пресете; колонки записи и «потерянных» упрощены (их правила требуют видов мероприятий и причин мира)
  const columns = preset.spaces.sales.board.columns.filter((c) => ['new', 'callback', 'purchase'].includes(c.key));
  columns.push({ key: 'agreed', label: { ru: 'Договорились' }, states: ['agreed'] }, { key: 'trash', label: { ru: 'Нецелевые' }, states: ['not_interested', 'not_target', 'do_not_call', 'written_off'] });
  (docs.spaces['sales'] as Record<string, unknown>)['board'] = { columns, tones: preset.spaces.sales.board.tones };
  resetConfigCache();
  await writeConfig({ docs: docs as never, source: 'cli', authorId: null, project: true, note: 'шапка карточки: доска стенда' });
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
  // Подпись колонки и тон приходят с сервера из пресета (board.tones: явка в группе — success)
  assert.equal(head.board.columnLabel, 'Перезвон');
  assert.equal(head.board.tone, 'success');
});

test('«покупал»: раскрывается только с deal.read; роль без deal.read получает false при покупках', async () => {
  const id = cardOf('a', 5);
  const client = clientOf('a', 5);
  await db.sql`UPDATE cards SET purchases_total = 1 WHERE id = ${id}`;
  const rop = await viewerOf(U.rop);
  assert.ok(rop.grants.has('deal.read'));
  assert.equal((await withBoard(true, () => getClientCard(rop, client))).card?.board?.purchased, true);
  // Консультант видит карточку клиента из своего окна записи, но без deal.read
  await db.sql`UPDATE cards SET purchases_total = 1 WHERE id = ${FX.bkInWindow.card}`;
  const cons = await viewerOf(U.consultant);
  assert.equal(cons.grants.has('deal.read'), false, 'консультант без deal.read');
  const head = (await withBoard(true, () => getClientCard(cons, FX.bkInWindow.client))).card;
  assert.ok(head?.board, 'шапка доски у консультанта есть');
  assert.equal(head.board.purchased, false);
});

test('OP_BOARD выключен: подписи колонок ленты пусты', async () => {
  const v = await viewerOf(U.opA);
  assert.deepEqual((await withBoard(false, () => loadFeedCatalog(v))).columns, {});
  assert.ok(Object.keys((await withBoard(true, () => loadFeedCatalog(v))).columns).length > 0, 'с флагом колонки есть');
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
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${cardOf('a', 1)}`;
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

test('«Покупка»: только из agreed/callback/client, из new, retry и not_interested кнопки нет', async () => {
  const rop = await viewerOf(U.rop);
  const card = cardOf('a', 1);
  const rows = await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = ${card}`;
  const state = rows[0]!.state;
  try {
    for (const [st, want] of [['new', false], ['retry', false], ['not_interested', false], ['agreed', true], ['callback', true], ['client', true]] as const) {
      await db.sql`UPDATE cards SET state = ${st} WHERE id = ${card}`;
      assert.equal((await getClientCard(rop, clientOf('a', 1))).can.purchase, want, st);
    }
  } finally {
    await db.sql`UPDATE cards SET state = ${state} WHERE id = ${card}`;
  }
});

test('«Покупка» выключается флагом раздела покупок', async () => {
  process.env['FEATURE_PURCHASES'] = '0';
  try {
    assert.equal((await getClientCard(await viewerOf(U.rop), clientOf('a', 1))).can.purchase, false);
  } finally {
    process.env['FEATURE_PURCHASES'] = '1';
  }
});
