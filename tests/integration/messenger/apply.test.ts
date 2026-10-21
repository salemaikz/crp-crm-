// Применение событий мессенджера (O7a, дизайн §8.5–8.6): неизвестный номер → клиент через общий путь приёма,
// карточка по правилу входящих, задача «Ответить»; событие карточку НЕ трогает; лимиты; каналы и тревоги.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMessengerEvents, REPLY_TASKS_PER_DAY, resetChannelRefreshForTests } from '../../../src/server/domain/messenger';
import { INBOUND_NEW_CLIENTS_PER_DAY } from '../../../src/server/domain/intake';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { INTEGRATION, CHANNEL, CHANNEL_REF, HOUR, MIN, NEW_NUMBER, NOW, SPACE, actor, channelEvent, closeMessengerWorld, msg, openMessengerWorld, status, worldDeps } from './world';

let db: TestDb;
before(async () => {
  db = await openMessengerWorld();
});
after(async () => {
  await closeMessengerWorld(db);
});
beforeEach(async () => {
  resetChannelRefreshForTests();
  // Каждый тест начинает с чистой переписки; клиенты изоляции остаются, созданные тестом удаляются
  await db.sql`DELETE FROM notifications WHERE kind LIKE 'messenger_%' OR kind = 'cards_assigned'`;
  await db.sql`DELETE FROM tasks WHERE source IN ('inbound_message','missed_call','dnc_inbound','review')`;
  await db.sql`DELETE FROM messenger_messages`;
  await db.sql`DELETE FROM messenger_chats`;
  await db.sql`DELETE FROM client_events WHERE kind IN ('message','card.created','client.created','card.assigned') AND client_id LIKE 'm-%' OR client_id IN (SELECT id FROM clients WHERE source_kind = 'messenger')`;
  await db.sql`DELETE FROM assign_log WHERE kind = 'inbound'`;
  await db.sql`DELETE FROM cards WHERE client_id IN (SELECT id FROM clients WHERE source_kind = 'messenger')`;
  await db.sql`DELETE FROM client_sources WHERE source_kind = 'messenger'`;
  await db.sql`DELETE FROM client_phones WHERE client_id IN (SELECT id FROM clients WHERE source_kind = 'messenger')`;
  await db.sql`DELETE FROM clients WHERE source_kind = 'messenger'`;
  await db.sql`UPDATE messenger_channels SET owner_user_id = NULL, state = 'active', state_changed_at = ${NOW}, is_enabled = TRUE WHERE id = ${CHANNEL}`;
  await db.sql`UPDATE integrations SET enabled = TRUE WHERE id = ${INTEGRATION}`;
});

const apply = (events: Parameters<typeof applyMessengerEvents>[2]['events'], over: { attempt?: number; now?: number } = {}) =>
  applyMessengerEvents(actor, worldDeps({ now: () => over.now ?? NOW }), { integrationId: INTEGRATION, pluginId: 'messenger.wazzup', events, ...(over.attempt ? { attempt: over.attempt } : {}) });

const one = async <T>(q: Promise<T[]>): Promise<T> => {
  const rows = await q;
  assert.equal(rows.length, 1, 'ожидалась одна строка');
  return rows[0] as T;
};
const clientOfNumber = (digits: string) => db.sql<{ id: string; name: string; sourceKind: string; sourceKey: string }>`
  SELECT c.id, c.name, c.source_kind, c.source_key FROM clients c JOIN client_phones p ON p.client_id = c.id WHERE p.digits = ${digits}`;
const tasksOf = (source: string) => db.sql<{ id: string; assigneeUserId: string; kind: string; sourceKey: string; dueAt: number; status: string; clientId: string }>`
  SELECT id, assignee_user_id, kind, source_key, due_at, status, client_id FROM tasks WHERE source = ${source} ORDER BY created_at, id`;

test('неизвестный номер: клиент из источника whatsapp_in, карточка у менее загруженного, задача «Ответить»', async () => {
  const m = msg();
  assert.deepEqual(await apply([m]), { status: 'done' });
  const client = await one(clientOfNumber(NEW_NUMBER));
  assert.equal(client.name, 'Клиент Синтетик');
  assert.equal(client.sourceKind, 'messenger');
  assert.equal(client.sourceKey, 'whatsapp_in');
  const phone = await one(db.sql<{ kind: string; isPrimary: boolean; isWorking: boolean }>`SELECT kind, is_primary, is_working FROM client_phones WHERE client_id = ${client.id}`);
  assert.deepEqual(phone, { kind: 'mobile', isPrimary: true, isWorking: true });
  const src = await one(db.sql<{ sourceKind: string; sourceKey: string }>`SELECT source_kind, source_key FROM client_sources WHERE client_id = ${client.id}`);
  assert.deepEqual(src, { sourceKind: 'messenger', sourceKey: 'whatsapp_in' });
  // Рабочее время (ср 11:00), канал общий → наименее загруженный участник; при равенстве — по id
  const card = await one(db.sql<{ id: string; state: string; ownerUserId: string; touchedInCrm: boolean; holdReason: string }>`SELECT id, state, owner_user_id, touched_in_crm, hold_reason FROM cards WHERE client_id = ${client.id}`);
  assert.deepEqual({ ...card, id: undefined }, { id: undefined, state: 'new', ownerUserId: U.duty, touchedInCrm: true, holdReason: '' });
  const log = await one(db.sql<{ kind: string; toUserId: string; countsToCap: boolean }>`SELECT kind, to_user_id, counts_to_cap FROM assign_log WHERE card_id = ${card.id}`);
  assert.deepEqual(log, { kind: 'inbound', toUserId: U.duty, countsToCap: false });
  const kinds = (await db.sql<{ kind: string }>`SELECT kind FROM client_events WHERE client_id = ${client.id} ORDER BY kind`).map((r) => r.kind);
  assert.deepEqual(kinds, ['card.assigned', 'card.created', 'client.created', 'message']);
  const task = await one(tasksOf('inbound_message'));
  assert.equal(task.assigneeUserId, U.duty);
  assert.equal(task.kind, 'message');
  assert.equal(task.dueAt, NOW + 15 * MIN);
  const chat = await one(db.sql<{ id: string; clientId: string; awaitingReply: boolean; lastInboundAt: number }>`SELECT id, client_id, awaiting_reply, last_inbound_at FROM messenger_chats`);
  assert.equal(task.sourceKey, `reply:${chat.id}`);
  assert.deepEqual({ ...chat, id: undefined }, { id: undefined, clientId: client.id, awaitingReply: true, lastInboundAt: NOW });
  const stored = await one(db.sql<{ body: string; direction: string }>`SELECT body, direction FROM messenger_messages`);
  assert.deepEqual(stored, { body: 'Здравствуйте, это синтетика', direction: 'in' });
});

test('владелец канала — участник раздачи: карточка ему; не в раздаче (пауза) — наименее загруженному', async () => {
  await db.sql`UPDATE messenger_channels SET owner_user_id = ${U.opB} WHERE id = ${CHANNEL}`;
  await apply([msg()]);
  const card = await one(db.sql<{ ownerUserId: string }>`SELECT c.owner_user_id FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE cl.source_kind = 'messenger'`);
  assert.equal(card.ownerUserId, U.opB);
  assert.equal((await one(tasksOf('inbound_message'))).assigneeUserId, U.opB);

  await db.sql`UPDATE memberships SET paused_on = '2026-10-28' WHERE user_id = ${U.opB}`;
  try {
    await apply([msg({ chatId: '77090000502', chatDigits: '77090000502' })]);
    const second = await one(db.sql<{ ownerUserId: string }>`SELECT c.owner_user_id FROM cards c JOIN client_phones p ON p.client_id = c.client_id WHERE p.digits = '77090000502'`);
    assert.equal(second.ownerUserId, U.duty, 'на паузе — не принимает входящее, берёт наименее загруженный');
  } finally {
    await db.sql`UPDATE memberships SET paused_on = '' WHERE user_id = ${U.opB}`;
  }
});

test('вне рабочего времени: карточка остаётся в пуле, задачу получает РОП', async () => {
  await apply([msg()], { now: NOW + 11 * HOUR });
  const card = await one(db.sql<{ ownerUserId: string | null; state: string }>`SELECT c.owner_user_id, c.state FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE cl.source_kind = 'messenger'`);
  assert.deepEqual(card, { ownerUserId: null, state: 'new' });
  assert.equal((await one(tasksOf('inbound_message'))).assigneeUserId, U.rop);
  assert.equal((await db.sql`SELECT 1 FROM assign_log WHERE kind = 'inbound'`).length, 0);
});

test('второе входящее не создаёт вторую задачу; эхо закрывает; входящее после ответа — новая задача', async () => {
  await apply([msg({ providerMessageId: 'pm-1' })]);
  await apply([msg({ providerMessageId: 'pm-2', text: 'Ещё вопрос' })]);
  assert.equal((await tasksOf('inbound_message')).length, 1);
  await apply([msg({ providerMessageId: 'pm-3', direction: 'out', text: 'Ответ', authorRef: U.opA, sentAt: NOW + MIN })]);
  const [closed] = await tasksOf('inbound_message');
  assert.equal(closed?.status, 'done');
  const chat = await one(db.sql<{ awaitingReply: boolean }>`SELECT awaiting_reply FROM messenger_chats`);
  assert.equal(chat.awaitingReply, false);
  const out = await one(db.sql<{ authorUserId: string }>`SELECT author_user_id FROM messenger_messages WHERE provider_message_id = 'pm-3'`);
  assert.equal(out.authorUserId, U.opA, 'автор исходящего — наш сотрудник');
  const echoEvent = await one(db.sql<{ actorId: string }>`SELECT actor_id FROM client_events WHERE kind = 'message' AND data->>'direction' = 'out'`);
  assert.equal(echoEvent.actorId, U.opA);
  await apply([msg({ providerMessageId: 'pm-4', text: 'Спасибо!', sentAt: NOW + 2 * MIN })]);
  const all = await tasksOf('inbound_message');
  assert.deepEqual(all.map((t) => t.status).sort(), ['done', 'open']);
});

test('повторная доставка того же сообщения и событие после правки — без дублей', async () => {
  const m = msg({ providerMessageId: 'pm-dup' });
  await apply([m]);
  await apply([m]);
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 1);
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE kind = 'message'`).length, 1);
  assert.equal((await tasksOf('inbound_message')).length, 1);
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 1);
});

test('правка меняет текст, удаление обнуляет его навсегда', async () => {
  await apply([msg({ providerMessageId: 'pm-e', text: 'Первый' })]);
  await apply([msg({ providerMessageId: 'pm-e', text: 'Исправлено', isEdited: true })]);
  assert.equal((await one(db.sql<{ body: string; isEdited: boolean }>`SELECT body, is_edited FROM messenger_messages`)).body, 'Исправлено');
  await apply([msg({ providerMessageId: 'pm-e', text: null, isDeleted: true })]);
  assert.deepEqual(await one(db.sql<{ body: string | null; isDeleted: boolean }>`SELECT body, is_deleted FROM messenger_messages`), { body: null, isDeleted: true });
  await apply([msg({ providerMessageId: 'pm-e', text: 'Воскрешение', isEdited: true })]);
  assert.equal((await one(db.sql<{ body: string | null }>`SELECT body FROM messenger_messages`)).body, null, 'удалённое не возвращается');
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE kind = 'message'`).length, 1, 'правка и удаление новых событий ленты не создают');
});

test('«Не звонить»: состояние карточки не меняется, задача РОП, «Ответить» не создаётся', async () => {
  await db.sql`UPDATE cards SET state = 'do_not_call' WHERE id = 'cd-a-5'`;
  const number = await one(db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-a-5'`);
  const before = await one(db.sql<Record<string, unknown>>`SELECT state, version, updated_at, owner_user_id, next_call_at, hold_reason, last_touch_at FROM cards WHERE id = 'cd-a-5'`);
  await apply([msg({ chatId: number.digits, chatDigits: number.digits, providerMessageId: 'pm-dnc' })]);
  const after = await one(db.sql<Record<string, unknown>>`SELECT state, version, updated_at, owner_user_id, next_call_at, hold_reason, last_touch_at FROM cards WHERE id = 'cd-a-5'`);
  assert.deepEqual(after, before, 'событие мессенджера не трогает карточку');
  const [t] = await tasksOf('dnc_inbound');
  assert.equal(t?.assigneeUserId, U.rop);
  assert.equal(t?.sourceKey, 'dnc_inbound:cl-a-5');
  assert.equal(t?.clientId, 'cl-a-5');
  assert.equal((await tasksOf('inbound_message')).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE client_id = 'cl-a-5' AND kind = 'message'`).length, 1, 'в ленту сообщение попадает');
  await db.sql`UPDATE cards SET state = 'retry' WHERE id = 'cd-a-5'`;
});

test('известный клиент: сообщение в ленту, «Ответить» владельцу карточки', async () => {
  const number = (await one(db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-b-7'`)).digits;
  await apply([msg({ chatId: number, chatDigits: number })]);
  const t = await one(tasksOf('inbound_message'));
  assert.equal(t.assigneeUserId, U.opB);
  assert.equal(t.clientId, 'cl-b-7');
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0, 'нового клиента нет');
});

test('номер у двух клиентов: клиент с последним касанием и задача РОП «проверить»', async () => {
  const number = (await one(db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-a-8'`)).digits;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES ('ph-dup-1', 'cl-b-8', ${number}, 'mobile', FALSE, ${NOW})`;
  await db.sql`UPDATE cards SET last_touch_at = ${NOW - HOUR} WHERE id = 'cd-a-8'`;
  await db.sql`UPDATE cards SET last_touch_at = ${NOW - 5 * MIN} WHERE id = 'cd-b-8'`;
  try {
    await apply([msg({ chatId: number, chatDigits: number })]);
    assert.equal((await one(tasksOf('inbound_message'))).clientId, 'cl-b-8');
    const review = await one(tasksOf('review'));
    assert.equal(review.assigneeUserId, U.rop);
    assert.equal(review.kind, 'check');
    assert.equal(review.clientId, 'cl-b-8');
  } finally {
    await db.sql`DELETE FROM client_phones WHERE id = 'ph-dup-1'`;
    await db.sql`UPDATE cards SET last_touch_at = NULL WHERE id IN ('cd-a-8','cd-b-8')`;
  }
});

test('слитый клиент: номер ведёт к выжившему', async () => {
  const number = (await one(db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-a-9'`)).digits;
  await db.sql`UPDATE clients SET merged_into_id = 'cl-b-9' WHERE id = 'cl-a-9'`;
  try {
    await apply([msg({ chatId: number, chatDigits: number })]);
    assert.equal((await one(tasksOf('inbound_message'))).clientId, 'cl-b-9');
  } finally {
    await db.sql`UPDATE clients SET merged_into_id = NULL WHERE id = 'cl-a-9'`;
  }
});

test('исходящее на неизвестный номер: чат и сообщение есть, клиента нет', async () => {
  await apply([msg({ direction: 'out', authorRef: U.opA })]);
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 1);
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0);
  assert.equal((await tasksOf('inbound_message')).length, 0);
  assert.equal((await one(db.sql<{ clientId: string | null }>`SELECT client_id FROM messenger_chats`)).clientId, null);
});

test('номер в стоп-листе: клиент не создаётся, РОП получает уведомление один раз за день', async () => {
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77090000555')}, 'manual', 'manual', ${NOW})`;
  try {
    await apply([msg({ chatId: '77090000555', chatDigits: '77090000555', providerMessageId: 'pm-s1' })]);
    await apply([msg({ chatId: '77090000555', chatDigits: '77090000555', providerMessageId: 'pm-s2' })]);
    assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0);
    const n = await db.sql<{ userId: string; kind: string }>`SELECT user_id, kind FROM notifications WHERE kind = 'messenger_dnc_unknown'`;
    assert.deepEqual(n, [{ userId: U.rop, kind: 'messenger_dnc_unknown' }]);
    assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 2);
  } finally {
    await db.sql`DELETE FROM stop_list WHERE phone_hmac = ${phoneHmac('77090000555')}`;
  }
});

test('пропущенный звонок WhatsApp: задача «Перезвонить» исполнителю карточки', async () => {
  const number = (await one(db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-b-10'`)).digits;
  await apply([msg({ chatId: number, chatDigits: number, msgType: 'missing_call', text: null, providerMessageId: 'pm-call' })]);
  const t = await one(tasksOf('missed_call'));
  assert.equal(t.assigneeUserId, U.opB);
  assert.equal(t.kind, 'call');
  assert.match(t.sourceKey, /^missed:wa:/);
  assert.equal((await tasksOf('inbound_message')).length, 0);
});

test('чужой канал: событие пропущено, ничего не создано; сверка каналов у провайдера не чаще раза в 5 минут', async () => {
  let calls = 0;
  const deps = worldDeps({
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify([{ guid: CHANNEL_REF, transport: 'whatsapp', plainId: '77091112233', state: 'active' }]));
    },
  });
  const run = (e: ReturnType<typeof msg>) => applyMessengerEvents(actor, deps, { integrationId: INTEGRATION, pluginId: 'messenger.wazzup', events: [e] });
  assert.deepEqual(await run(msg({ channelRef: 'foreign-channel' })), { status: 'done' });
  assert.deepEqual(await run(msg({ channelRef: 'foreign-channel', providerMessageId: 'pm-f2' })), { status: 'done' });
  assert.equal(calls, 1, 'повторная сверка в пределах 5 минут не идёт');
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM messenger_channels WHERE provider_channel_id = 'foreign-channel'`).length, 0);
});

test('канал, появившийся у провайдера после подключения, подтягивается сверкой выключенным; администратор уведомлён (D-298)', async () => {
  const deps = worldDeps({
    fetch: async () => new Response(JSON.stringify([{ guid: 'wz-channel-new', transport: 'whatsapp', plainId: '77091112244', state: 'active' }])),
  });
  const run = (id: string) => applyMessengerEvents(actor, deps, { integrationId: INTEGRATION, pluginId: 'messenger.wazzup', events: [msg({ channelRef: 'wz-channel-new', providerMessageId: id })] });
  try {
    assert.deepEqual(await run('pm-new'), { status: 'done' });
    const ch = await one(db.sql<{ id: string; isEnabled: boolean }>`SELECT id, is_enabled FROM messenger_channels WHERE provider_channel_id = 'wz-channel-new'`);
    assert.equal(ch.isEnabled, false, 'новый канал выключен, пока администратор не решит');
    assert.equal((await db.sql`SELECT 1 FROM messenger_messages WHERE provider_message_id = 'pm-new'`).length, 0, 'сообщение выключенного канала не сохраняется');
    assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0);
    const n = await db.sql<{ userId: string; entityId: string; params: unknown }>`SELECT user_id, entity_id, params FROM notifications WHERE kind = 'messenger_channel_new'`;
    assert.deepEqual(n.map((r) => r.userId), [U.admin], 'уведомление — администраторам');
    assert.equal(n[0]?.entityId, ch.id);
    assert.deepEqual(n[0]?.params, {});
    resetChannelRefreshForTests();
    await run('pm-new-2');
    assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'messenger_channel_new'`).length, 1, 'о канале сообщаем один раз');
    // Администратор включил канал — сообщения принимаются
    await db.sql`UPDATE messenger_channels SET is_enabled = TRUE WHERE id = ${ch.id}`;
    await run('pm-new-3');
    assert.equal((await db.sql`SELECT 1 FROM messenger_messages WHERE provider_message_id = 'pm-new-3'`).length, 1);
  } finally {
    await db.sql`DELETE FROM messenger_messages`;
    await db.sql`DELETE FROM messenger_chats`;
    await db.sql`DELETE FROM messenger_channels WHERE provider_channel_id = 'wz-channel-new'`;
  }
});

test('выключенный канал: входящее пропускается — ни клиента, ни текста, ни задачи; тревоги по нему нет (D-298)', async () => {
  await db.sql`UPDATE messenger_channels SET is_enabled = FALSE WHERE id = ${CHANNEL}`;
  const known = '77090000001';
  assert.deepEqual(await apply([msg(), msg({ chatId: known, chatDigits: known, providerMessageId: 'pm-known' })]), { status: 'done' });
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM messenger_chats`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0);
  assert.equal((await tasksOf('inbound_message')).length, 0);
  await apply([channelEvent('disabled', NOW + MIN)]);
  assert.equal((await one(db.sql<{ state: string }>`SELECT state FROM messenger_channels WHERE id = ${CHANNEL}`)).state, 'disabled', 'состояние обновляется');
  assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'messenger_channel_down'`).length, 0, 'тревоги по выключенному каналу нет');
});

test('статус раньше сообщения: retry, с 3-й попытки событие считается устаревшим; статус не затирается старым', async () => {
  assert.deepEqual(await apply([status('pm-late', 'delivered')], { attempt: 1 }), { status: 'retry', error: 'message_not_yet' });
  assert.deepEqual(await apply([status('pm-late', 'delivered')], { attempt: 3 }), { status: 'done' });
  await apply([msg({ providerMessageId: 'pm-st', direction: 'out', authorRef: U.opA, status: 'sent', sentAt: NOW })]);
  await apply([status('pm-st', 'read', NOW + 3 * MIN)]);
  await apply([status('pm-st', 'delivered', NOW + 1 * MIN)]);
  assert.equal((await one(db.sql<{ status: string }>`SELECT status FROM messenger_messages WHERE provider_message_id = 'pm-st'`)).status, 'read');
});

test('тревога по каналу: не active → уведомление администратору и РОП один раз за день; устаревшее событие молчит', async () => {
  await apply([channelEvent('disabled', NOW + MIN)]);
  await apply([channelEvent('disabled', NOW + 2 * MIN)]);
  const n = await db.sql<{ userId: string; params: { state: string } }>`SELECT user_id, params FROM notifications WHERE kind = 'messenger_channel_down' ORDER BY user_id`;
  assert.ok(n.some((r) => r.userId === U.admin), 'администратор');
  assert.ok(n.some((r) => r.userId === U.rop), 'РОП');
  assert.ok(!n.some((r) => r.userId === U.opA), 'оператору тревога по каналу не нужна');
  assert.equal(new Set(n.map((r) => r.userId)).size, n.length, 'один получатель — одно уведомление в день');
  assert.deepEqual(n[0]?.params, { state: 'disabled' });
  assert.equal((await one(db.sql<{ state: string }>`SELECT state FROM messenger_channels WHERE id = ${CHANNEL}`)).state, 'disabled');
  const count = n.length;
  await apply([channelEvent('qr', NOW - HOUR)]);
  assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'messenger_channel_down'`).length, count, 'старое событие не поднимает тревогу');
  assert.equal((await one(db.sql<{ state: string }>`SELECT state FROM messenger_channels WHERE id = ${CHANNEL}`)).state, 'disabled');
  await apply([channelEvent('active', NOW + 3 * MIN)]);
  assert.equal((await one(db.sql<{ state: string }>`SELECT state FROM messenger_channels WHERE id = ${CHANNEL}`)).state, 'active');
  assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'messenger_channel_down'`).length, count, 'восстановление тревоги не создаёт');
});

test('выключенное подключение: события сбрасываются без записи', async () => {
  await db.sql`UPDATE integrations SET enabled = FALSE WHERE id = ${INTEGRATION}`;
  assert.deepEqual(await apply([msg()]), { status: 'done' });
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM clients WHERE source_kind = 'messenger'`).length, 0);
});

test('предел новых клиентов из мессенджера в сутки: сверх предела клиент не создаётся, РОП уведомлён', async () => {
  await db.sql`
    INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, source_key, created_at, updated_at)
    SELECT 'm-' || i, 'person', 'Синтетика ' || i, 'синтетика', 'синтетика', 'messenger', 'whatsapp_in', ${NOW}, ${NOW}
      FROM generate_series(1, ${INBOUND_NEW_CLIENTS_PER_DAY}::int) AS i`;
  await db.sql`
    INSERT INTO client_sources (id, client_id, source_kind, source_key, first_seen_at)
    SELECT 'mcs-' || i, 'm-' || i, 'messenger', 'whatsapp_in', ${NOW - 10 * MIN} FROM generate_series(1, ${INBOUND_NEW_CLIENTS_PER_DAY}::int) AS i`;
  await apply([msg({ chatId: '77090000777', chatDigits: '77090000777' })]);
  assert.equal((await db.sql`SELECT 1 FROM client_phones WHERE digits = '77090000777'`).length, 0);
  const n = await db.sql<{ userId: string; params: { limit: number } }>`SELECT user_id, params FROM notifications WHERE kind = 'messenger_flood'`;
  assert.deepEqual(n.map((r) => [r.userId, r.params]), [[U.rop, { limit: 200 }]]);
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 1, 'сообщение сохранено в чате');
});

test('предел задач «Ответить» по известным клиентам в сутки: сверх предела задачи нет, уведомление РОП и администратору', async () => {
  await db.sql`
    INSERT INTO messenger_chats (id, channel_id, chat_type, chat_id, created_at)
    SELECT 'lim-chat-' || i, ${CHANNEL}, 'whatsapp', 'lim' || i, ${NOW} FROM generate_series(1, ${REPLY_TASKS_PER_DAY}::int) AS i`;
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_at)
    SELECT 'lim-task-' || i, ${SPACE}, 'cl-a-' || (1 + i % 50), 'message', 'inbound_message', '', ${NOW}, ${U.opA}, 'done', 'reply:lim-chat-' || i, ${NOW - 5 * MIN}
      FROM generate_series(1, ${REPLY_TASKS_PER_DAY}::int) AS i`;
  const number = (await one(db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = 'cl-a-60'`)).digits;
  await apply([msg({ chatId: number, chatDigits: number })]);
  assert.equal((await db.sql`SELECT 1 FROM tasks WHERE source = 'inbound_message' AND status = 'open'`).length, 0);
  const n = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'messenger_flood' ORDER BY user_id`;
  assert.deepEqual(n.map((r) => r.userId).sort(), [U.admin, U.rop].sort());
  assert.equal((await db.sql`SELECT 1 FROM messenger_messages`).length, 1);
  await db.sql`DELETE FROM tasks WHERE id LIKE 'lim-task-%'`;
  await db.sql`DELETE FROM messenger_chats WHERE id LIKE 'lim-chat-%'`;
});
