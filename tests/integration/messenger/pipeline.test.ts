// Сквозной путь на фикстурах: вебхук Wazzup → общий приём → webhook_inbox → обработчик очереди воркера → клиент,
// сообщение, задача, лента. Сети нет: плагин настоящий, провайдер — только тело запроса из tests/integrations.
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../../../src/integrations/registry';
import { receiveWebhook } from '../../../src/server/domain/integrations';
import { applyMessengerEvents } from '../../../src/server/domain/messenger';
import { webhookHandlers } from '../../../src/server/jobs/integrations';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { INTEGRATION, TOKEN, actor, addChannel, closeMessengerWorld, openMessengerWorld, worldDeps } from './world';

const FIXTURE_CHANNEL = '11111111-1111-4111-8111-111111111111';
const fx = (name: string): string => readFileSync(new URL(`../../integrations/messenger.wazzup/fixtures/${name}.json`, import.meta.url), 'utf8');

let db: TestDb;
before(async () => {
  db = await openMessengerWorld();
  await addChannel(db.sql, 'ch-fx', FIXTURE_CHANNEL, null);
});
after(async () => {
  await closeMessengerWorld(db);
});

const deliver = (body: string, token = TOKEN) =>
  receiveWebhook(worldDeps(), { pluginId: 'messenger.wazzup', token, req: new Request('https://crm.test/api/hooks/messenger.wazzup/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body }) });

const handlers = webhookHandlers(registry, { messenger: (a, i) => applyMessengerEvents(a, worldDeps(), i) });
const signal = new AbortController().signal;

/** Прогнать все ожидающие строки inbox через обработчик очереди, как воркер. */
async function drain(): Promise<string[]> {
  const rows = await db.sql<{ id: string; kind: string }>`SELECT id, kind FROM webhook_inbox WHERE state = 'pending' ORDER BY received_at, dedupe_key`;
  const out: string[] = [];
  for (const r of rows) {
    const res = await handlers.get('messenger.wazzup')!(actor, { id: r.id, handlerKey: 'messenger.wazzup', kind: r.kind, attempt: 1 }, signal);
    out.push(res.status);
    await db.sql`UPDATE webhook_inbox SET state = ${res.status === 'done' ? 'done' : 'failed'} WHERE id = ${r.id}`;
  }
  return out;
}

test('тест провайдера — 200 без записи; чужой токен — 404', async () => {
  assert.equal((await deliver(fx('test'))).status, 200);
  assert.equal((await deliver(fx('message-in'), 'x'.repeat(43))).status, 404);
  assert.equal((await db.sql`SELECT 1 FROM webhook_inbox`).length, 0);
});

test('входящее от неизвестного номера → клиент, задача «Ответить», сообщение в ленту; повторная доставка ничего не задваивает', async () => {
  assert.equal((await deliver(fx('message-in'))).status, 200);
  assert.equal((await deliver(fx('message-in'))).status, 200);
  assert.equal((await db.sql`SELECT 1 FROM webhook_inbox`).length, 1);
  assert.deepEqual(await drain(), ['done']);
  const client = (await db.sql<{ id: string; name: string }>`SELECT c.id, c.name FROM clients c JOIN client_phones p ON p.client_id = c.id WHERE p.digits = '77090009001'`)[0];
  assert.ok(client);
  assert.equal(client.name, 'Клиент Синтетика');
  const task = (await db.sql<{ source: string; assigneeUserId: string }>`SELECT source, assignee_user_id FROM tasks WHERE client_id = ${client.id}`)[0];
  assert.equal(task?.source, 'inbound_message');
  assert.equal(task?.assigneeUserId, U.duty);
  const ev = await db.sql<{ kind: string; refType: string }>`SELECT kind, ref_type FROM client_events WHERE client_id = ${client.id} AND kind = 'message'`;
  assert.deepEqual(ev, [{ kind: 'message', refType: 'messenger_message' }]);
  // нового вебхука с тем же сообщением нет — очередь пуста
  assert.deepEqual(await drain(), []);
});

test('эхо оператора закрывает задачу, статусы доставки обновляют сообщение, канал не active — тревога', async () => {
  await deliver(fx('message-echo'));
  await drain();
  const open = await db.sql`SELECT 1 FROM tasks WHERE source = 'inbound_message' AND status = 'open'`;
  assert.equal(open.length, 0, 'ответ оператора закрыл «Ответить»');
  await deliver(fx('statuses'));
  assert.deepEqual(await drain(), ['done', 'done']);
  const m = await db.sql<{ status: string }>`SELECT status FROM messenger_messages WHERE provider_message_id = 'aaaaaaaa-0000-4000-8000-000000000002'`;
  assert.equal(m[0]?.status, 'read');
  // Два события канала приходят вразнобой: старое состояние qr после нового active тревогу не поднимает
  await deliver(fx('channels-qr'));
  assert.deepEqual(await drain(), ['done', 'done']);
  assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'messenger_channel_down'`).length, 0);
  const state = () => db.sql<{ state: string }>`SELECT state FROM messenger_channels WHERE integration_id = ${INTEGRATION} AND provider_channel_id = ${FIXTURE_CHANNEL}`;
  assert.equal((await state())[0]?.state, 'active');
  // Канал отключился: администратор и РОП получают тревогу
  await deliver(JSON.stringify({ channelsUpdates: [{ channelId: FIXTURE_CHANNEL, timestamp: 1793180760000 + 300_000, state: 'disabled' }] }));
  assert.deepEqual(await drain(), ['done']);
  const alerts = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'messenger_channel_down'`;
  assert.ok(alerts.some((a) => a.userId === U.admin) && alerts.some((a) => a.userId === U.rop));
  assert.equal((await state())[0]?.state, 'disabled');
});

test('удаление и правка сообщения: текст в ленте обнулён', async () => {
  await deliver(fx('message-deleted'));
  await drain();
  const m = await db.sql<{ body: string | null; isDeleted: boolean }>`SELECT body, is_deleted FROM messenger_messages WHERE provider_message_id = 'aaaaaaaa-0000-4000-8000-000000000001'`;
  assert.deepEqual(m[0], { body: null, isDeleted: true });
  assert.equal((await db.sql`SELECT payload FROM webhook_inbox WHERE dedupe_key LIKE 'm:%:0:1'`).length, 1);
});
