// Звонок в ленте (C1): итог с заметкой отдаёт в элементе ленты код итога, причину, срок перезвона и текст заметки;
// текст читается по refId с охватом card.read карточки звонка; отменённый и чужой звонок — без текста.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientFeed } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { FX, SEED_NOW, SPACE, U, cardOf, clientOf, phoneOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from '../clients/world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const NOTE = 'Синтетическая заметка звонка: директор подумает до понедельника';

async function addCall(opts: { id: string; i: number; who?: 'a' | 'b'; note?: string; reason?: string; callbackAt?: number | null; precision?: 'time' | 'day'; voided?: boolean; via?: string }) {
  const who = opts.who ?? 'a';
  const client = clientOf(who, opts.i);
  const owner = who === 'a' ? U.opA : U.opB;
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, reason_code, note,
                                  callback_at, callback_precision, applied, occurred_at, received_at, duration_sec, config_rev)
               VALUES (${opts.id}, ${SPACE}, ${cardOf(who, opts.i)}, ${client}, ${owner}, ${opts.via ?? 'ui'}, ${phoneOf(who, opts.i)}, 'callback', 'callback',
                       ${opts.reason ?? ''}, ${opts.note ?? ''}, ${opts.callbackAt ?? null}, ${opts.precision ?? 'time'}, 'applied', ${SEED_NOW}, ${SEED_NOW}, 95, 1)`;
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
               VALUES (${`ev-${opts.id}`}, ${client}, ${SPACE}, 'call', ${owner}, ${SEED_NOW}, 'call', ${opts.id},
                       ${db.json({ outcome: 'callback', outcomeKind: 'callback', durationSec: 95 }) as never})`;
  if (opts.voided) {
    await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
                 VALUES (${`vo-${opts.id}`}, ${client}, ${SPACE}, 'call.voided', ${U.rop}, ${SEED_NOW + 1}, 'call', ${opts.id}, ${db.json({ callId: opts.id }) as never})`;
  }
}

const callItem = (page: Awaited<ReturnType<typeof getClientFeed>>, id: string) => page.items.find((x) => x.id === `ev-${id}`);

test('итог с заметкой: в ленте код итога, причина, срок перезвона с точностью и текст заметки', async () => {
  await addCall({ id: 'cf-1', i: 70, note: NOTE, reason: 'thinking', callbackAt: SEED_NOW + 3 * 86_400_000, precision: 'day' });
  const page = await getClientFeed(await viewerOf(U.opA), clientOf('a', 70), { cursor: null, groups: 'calls' });
  const it = callItem(page, 'cf-1');
  assert.ok(it, 'событие звонка есть');
  assert.equal(it.data.outcome, 'callback');
  assert.equal(it.data.durationSec, 95);
  assert.deepEqual(it.call, { note: NOTE, reasonCode: 'thinking', callbackAt: SEED_NOW + 3 * 86_400_000, callbackPrecision: 'day' });
});

test('оператор B на клиенте A: лента — 404, текст заметки не утекает', async () => {
  await assert.rejects(getClientFeed(await viewerOf(U.opB), clientOf('a', 70), { cursor: null, groups: 'calls' }), { code: 'not_found' });
});

test('отменённый звонок: событие остаётся, текста и причины нет', async () => {
  await addCall({ id: 'cf-2', i: 71, note: NOTE, reason: 'thinking', voided: true });
  const page = await getClientFeed(await viewerOf(U.opA), clientOf('a', 71), { cursor: null, groups: 'calls' });
  const it = callItem(page, 'cf-2');
  assert.ok(it, 'событие остаётся');
  assert.equal(it.call, null);
  assert.ok(!JSON.stringify(page).includes('директор подумает'));
});

test('звонок без заметки и срока: call с пустым текстом и без срока', async () => {
  await addCall({ id: 'cf-3', i: 72 });
  const it = callItem(await getClientFeed(await viewerOf(U.opA), clientOf('a', 72), { cursor: null, groups: 'calls' }), 'cf-3');
  assert.deepEqual(it?.call, { note: '', reasonCode: '', callbackAt: null, callbackPrecision: 'time' });
});

test('РОП видит заметку звонка своего пространства; консультант — по отношению записи, без него лента — 404', async () => {
  await addCall({ id: 'cf-4', i: 2, who: 'b', note: NOTE });
  const rop = await getClientFeed(await viewerOf(U.rop), FX.bkInWindow.client, { cursor: null, groups: 'calls' });
  assert.equal(callItem(rop, 'cf-4')?.call?.note, NOTE);
  const cons = await viewerOf(U.consultant);
  // Клиент в окне записи консультанта: card.read по отношению есть — заметка видна
  assert.equal(callItem(await getClientFeed(cons, FX.bkInWindow.client, { cursor: null, groups: 'calls' }), 'cf-4')?.call?.note, NOTE);
  // Клиент без отношения: ни ленты, ни заметки
  await assert.rejects(getClientFeed(cons, clientOf('a', 70), { cursor: null, groups: 'calls' }), { code: 'not_found' });
});

test('подписи ленты из настроек: итоги, причины итога по его группе, виды записи и этапы', async () => {
  const { loadFeedCatalog } = await import('../../../src/server/domain/clients');
  const c = await loadFeedCatalog(await viewerOf(U.opA));
  assert.ok(Object.keys(c.outcomes).length >= 7, 'итоги из настроек');
  assert.equal(c.outcomes['callback'], c.outcomes['callback']?.trim());
  // причины лежат под ключом `итог:причина`; группа — по правилу ядра (перезвон → callback, прочие → одноимённая)
  assert.equal(c.reasons['not_interested:expensive'], 'Дорого');
  assert.ok(Object.keys(c.stages).length > 0, 'этапы сделок');
  // сырых ключей вместо подписей нет
  for (const v of Object.values(c.outcomes)) assert.notEqual(v, '');
});
