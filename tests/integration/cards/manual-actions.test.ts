// Действия меню карточки (docs/tasks-team-design.md §5.2, C9): «Вернуть в обзвон» (в т. ч. с передачей одной
// транзакцией), «Снять «Не звонить»», «Не целевой» и «Полный отказ» из меню; права и `can`; виды списка клиентов.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, NotFoundError } from '../../../src/server/access';
import { clearDnc, closeCard, reopenCard } from '../../../src/server/domain/cards';
import { CardActionError } from '../../../src/server/domain/cards/errors';
import { TeamError } from '../../../src/server/domain/team/errors';
import { getClientCard, listClients, parseListQuery } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, cardOf, clientOf } from '../../isolation/harness/seed';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { callsConfig, closeCallsWorld, openCallsWorld, setCard, uuid, viewerOf } from '../calls/world';

let db: TestDb;
before(async () => {
  db = await openCallsWorld();
});
after(() => closeCallsWorld(db));

const card = async (i: number) =>
  (await db.sql<{ state: string; ownerUserId: string | null; version: number; closeReasonCode: string; closedAt: number | null }>`
    SELECT state, owner_user_id, version, close_reason_code, closed_at FROM cards WHERE id = ${cardOf('a', i)}`)[0]!;
const version = async (i: number) => (await card(i)).version;
const list = async (viewerId: string, qs: string) => {
  const v = await viewerOf(viewerId);
  return listClients(v, parseListQuery(new URLSearchParams(qs)));
};

test('«Не целевой» из меню без справочника причин: принимается любая непустая; оператор закрывает свою карточку', async () => {
  await setCard(db.sql, cardOf('a', 51), { state: 'retry', owner: U.opA });
  const op = await viewerOf(U.opA);
  const v = await version(51);
  const res = await closeCard(op, cardOf('a', 51), { opId: uuid(), version: v, kind: 'not_target', reasonCode: 'other', alsoDncPhoneIds: [] });
  assert.equal(res.state, 'not_target');
  const c = await card(51);
  assert.deepEqual([c.state, c.closeReasonCode, c.closedAt !== null, c.ownerUserId], ['not_target', 'other', true, U.opA]);
});

/** Справочник причин для «Не целевой» и «Полный отказ» (в минимальных настройках его нет). */
async function withReasons(): Promise<void> {
  const c = callsConfig();
  const sp = c.spaces.sales as { calling: { outcomes: Array<{ key: string; reasonGroup: string | null }> }; reasons: Record<string, unknown[]> };
  for (const o of sp.calling.outcomes) if (o.key === 'not_target' || o.key === 'do_not_call') o.reasonGroup = o.key;
  const r = (key: string) => ({ key, label: { ru: key }, needsText: false, softness: 'soft' });
  sp.reasons.not_target = [r('company_closed'), r('other')];
  sp.reasons.do_not_call = [r('asked'), r('other')];
  resetConfigCache();
  await writeConfig({ docs: c, source: 'cli', authorId: null, project: true, note: 'причины закрытия' });
}

test('закрытие: причина не из справочника — 400 reason_code; устаревшая версия — card_changed; чужая карточка — 404', async () => {
  await withReasons();
  await setCard(db.sql, cardOf('a', 52), { state: 'retry', owner: U.opA });
  const op = await viewerOf(U.opA);
  await assert.rejects(closeCard(op, cardOf('a', 52), { opId: uuid(), version: await version(52), kind: 'not_target', reasonCode: 'нет-такой', alsoDncPhoneIds: [] }), (e: unknown) => e instanceof BadRequestError && e.detail === 'reason_code');
  await assert.rejects(closeCard(op, cardOf('a', 52), { opId: uuid(), version: 9999, kind: 'not_target', reasonCode: 'other', alsoDncPhoneIds: [] }), (e: unknown) => e instanceof CardActionError && e.body.error === 'card_changed');
  const other = await viewerOf(U.opB);
  await assert.rejects(closeCard(other, cardOf('a', 52), { opId: uuid(), version: await version(52), kind: 'not_target', reasonCode: 'other', alsoDncPhoneIds: [] }), NotFoundError);
});

test('«Полный отказ» с номерами → стоп-лист; «Снять «Не звонить»» РОП: комментарий заметкой, номера из стоп-листа, перезвон', async () => {
  await setCard(db.sql, cardOf('a', 53), { state: 'callback', owner: U.opA });
  const op = await viewerOf(U.opA);
  const phones = await db.sql<{ id: string; digits: string }>`SELECT id, digits FROM client_phones WHERE client_id = ${clientOf('a', 53)} AND is_working`;
  assert.ok(phones.length >= 1);
  const inStop = async () => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM stop_list WHERE phone_hmac = ${phoneHmac(phones[0]!.digits)}`)[0]!.n;
  await closeCard(op, cardOf('a', 53), { opId: uuid(), version: await version(53), kind: 'do_not_call', reasonCode: 'asked', alsoDncPhoneIds: [phones[0]!.id] });
  assert.equal((await card(53)).state, 'do_not_call');
  assert.equal(await inStop(), 1);

  // оператору снятие недоступно: нет права = нет объекта
  await assert.rejects(clearDnc(op, cardOf('a', 53), { opId: uuid(), version: await version(53), comment: 'Клиент просит' }), NotFoundError);
  const rop = await viewerOf(U.rop);
  await assert.rejects(clearDnc(rop, cardOf('a', 53), { opId: uuid(), version: await version(53), comment: '   ' }), (e: unknown) => e instanceof CardActionError && e.code === 'comment_required');
  const res = await clearDnc(rop, cardOf('a', 53), { opId: uuid(), version: await version(53), comment: 'Клиент сам попросил перезвонить' });
  assert.equal(res.state, 'callback');
  const notes = await db.sql<{ body: string; authorId: string }>`SELECT body, author_id FROM notes WHERE client_id = ${clientOf('a', 53)}`;
  assert.deepEqual(notes, [{ body: 'Клиент сам попросил перезвонить', authorId: U.rop }]);
  assert.equal(await inStop(), 0);
  const audit = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'card.dnc_cleared'`;
  assert.ok((audit[0]?.n ?? 0) >= 1);
});

test('«Вернуть в обзвон»: владелец действует — callback, перезвон-задача, заметка, аудит; оператору 404', async () => {
  await setCard(db.sql, cardOf('a', 54), { state: 'not_target', owner: U.opA });
  const rop = await viewerOf(U.rop);
  const v = await version(54);
  const res = await reopenCard(rop, cardOf('a', 54), { opId: uuid(), version: v, comment: 'Появился бюджет' });
  assert.deepEqual([res.state, res.version], ['callback', v + 1]);
  const c = await card(54);
  assert.deepEqual([c.state, c.ownerUserId, c.closedAt, c.closeReasonCode], ['callback', U.opA, null, '']);
  const notes = await db.sql<{ body: string }>`SELECT body FROM notes WHERE client_id = ${clientOf('a', 54)}`;
  assert.deepEqual(notes.map((n) => n.body), ['Появился бюджет']);
  const audit = await db.sql<{ meta: { cardId: string; fromState: string } }>`SELECT meta FROM audit_log WHERE action = 'card.reopen' AND entity_id = ${cardOf('a', 54)}`;
  assert.deepEqual(audit[0]?.meta, { cardId: cardOf('a', 54), fromState: 'not_target' });
  const op = await viewerOf(U.opA);
  await assert.rejects(reopenCard(op, cardOf('a', 54), { opId: uuid(), version: 0, comment: 'x' }), NotFoundError);
});

test('«Вернуть в обзвон» без активного владельца: нужен получатель; transfer и reopen в одной транзакции (версия + 2)', async () => {
  await setCard(db.sql, cardOf('a', 55), { state: 'written_off', owner: U.disabled });
  const rop = await viewerOf(U.rop);
  const v = await version(55);
  await assert.rejects(reopenCard(rop, cardOf('a', 55), { opId: uuid(), version: v, comment: 'Вернуть' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'owner_required');
  assert.equal((await card(55)).state, 'written_off');
  // получатель отключён — тоже нельзя
  await assert.rejects(reopenCard(rop, cardOf('a', 55), { opId: uuid(), version: v, comment: 'Вернуть', toUserId: U.disabled }), BadRequestError);

  const res = await reopenCard(rop, cardOf('a', 55), { opId: uuid(), version: v, comment: 'Вернуть', toUserId: U.opB });
  assert.deepEqual([res.state, res.version], ['callback', v + 2]);
  const c = await card(55);
  assert.deepEqual([c.state, c.ownerUserId], ['callback', U.opB]);
  const log = await db.sql<{ kind: string }>`SELECT kind FROM assign_log WHERE card_id = ${cardOf('a', 55)} AND kind = 'transfer'`;
  assert.equal(log.length, 1);
});

test('«Вернуть в обзвон» без владельца: директор и консультант как получатель — 400 recipient, неизвестный id — 400, карточка не тронута', async () => {
  await setCard(db.sql, cardOf('a', 55), { state: 'written_off', owner: U.disabled });
  const rop = await viewerOf(U.rop);
  const v = await version(55);
  for (const toUserId of [U.director, U.consultant]) {
    await assert.rejects(
      reopenCard(rop, cardOf('a', 55), { opId: uuid(), version: v, comment: 'Вернуть', toUserId }),
      (e: unknown) => e instanceof TeamError && e.code === 'bad_request' && e.detail === 'recipient',
      toUserId,
    );
  }
  await assert.rejects(reopenCard(rop, cardOf('a', 55), { opId: uuid(), version: v, comment: 'Вернуть', toUserId: 'u-no-such' }), BadRequestError);
  const c = await card(55);
  assert.deepEqual([c.state, c.ownerUserId, c.version], ['written_off', U.disabled, v]);
});

test('can: закрытие — оператору и РОП, возврат и снятие — только РОП; по состоянию карточки', async () => {
  await setCard(db.sql, cardOf('a', 56), { state: 'retry', owner: U.opA });
  await setCard(db.sql, cardOf('a', 57), { state: 'not_interested', owner: U.opA });
  await setCard(db.sql, cardOf('a', 58), { state: 'do_not_call', owner: U.opA });
  const op = await viewerOf(U.opA);
  const rop = await viewerOf(U.rop);
  const pick = (c: Awaited<ReturnType<typeof getClientCard>>) => [c.can.closeFromMenu, c.can.reopen, c.can.unblock];
  assert.deepEqual(pick(await getClientCard(op, clientOf('a', 56))), [true, false, false]);
  assert.deepEqual(pick(await getClientCard(op, clientOf('a', 57))), [true, false, false]);
  assert.deepEqual(pick(await getClientCard(rop, clientOf('a', 57))), [true, true, false]);
  assert.deepEqual(pick(await getClientCard(op, clientOf('a', 58))), [false, false, false]);
  assert.deepEqual(pick(await getClientCard(rop, clientOf('a', 58))), [false, false, true]);
});

test('виды списка: «Мои клиенты» — agreed/client у меня или временный; архив — закрытые, оператору свои, РОП все, фильтр владельца', async () => {
  await setCard(db.sql, cardOf('a', 61), { state: 'agreed', owner: U.opA });
  await setCard(db.sql, cardOf('a', 62), { state: 'client', owner: U.opB, acting: U.opA });
  await setCard(db.sql, cardOf('a', 63), { state: 'callback', owner: U.opA });
  await setCard(db.sql, cardOf('a', 64), { state: 'not_interested', owner: U.opA });
  await setCard(db.sql, cardOf('a', 65), { state: 'written_off', owner: U.opB });
  await db.sql`UPDATE cards SET closed_at = 1000, close_reason_code = 'no_need' WHERE id = ${cardOf('a', 64)}`;
  await db.sql`UPDATE cards SET closed_at = 2000 WHERE id = ${cardOf('a', 65)}`;
  await db.sql`UPDATE cards SET hold_reason = 'merged', state = 'agreed' WHERE id = ${cardOf('a', 66)}`;

  const mine = await list(U.opA, 'view=mine&limit=50');
  const ids = mine.items.map((i) => i.cardId);
  assert.ok(ids.includes(cardOf('a', 61)));
  assert.ok(!ids.includes(cardOf('a', 63)), 'callback — не «мой клиент»');
  assert.ok(!ids.includes(cardOf('a', 66)), 'слитая карточка не показывается');
  assert.ok(mine.items.every((i) => i.state === 'agreed' || i.state === 'client'));

  const arch = await list(U.opA, 'view=archive&limit=50');
  const archIds = arch.items.map((i) => i.cardId);
  assert.ok(archIds.includes(cardOf('a', 64)));
  assert.ok(!archIds.includes(cardOf('a', 65)), 'чужой архив оператору не виден');
  assert.ok(arch.items.every((i) => ['not_interested', 'not_target', 'do_not_call', 'written_off'].includes(i.state)));
  const row = arch.items.find((i) => i.cardId === cardOf('a', 64));
  assert.deepEqual([row?.closeReasonCode, row?.closedAt], ['no_need', 1000]);

  const all = await list(U.rop, 'view=archive&limit=50');
  const order = all.items.map((i) => i.cardId);
  assert.ok(order.indexOf(cardOf('a', 65)) < order.indexOf(cardOf('a', 64)), 'сначала недавно закрытые');
  const byOwner = await list(U.rop, `view=archive&owner=${U.opB}&limit=50`);
  assert.ok(byOwner.items.length >= 1 && byOwner.items.every((i) => ['written_off', 'not_interested', 'not_target', 'do_not_call'].includes(i.state)));
  assert.ok(byOwner.items.some((i) => i.cardId === cardOf('a', 65)) && !byOwner.items.some((i) => i.cardId === cardOf('a', 64)));
  assert.throws(() => parseListQuery(new URLSearchParams('view=mine&owner=x')), BadRequestError);
  assert.throws(() => parseListQuery(new URLSearchParams('view=other')), BadRequestError);
});
