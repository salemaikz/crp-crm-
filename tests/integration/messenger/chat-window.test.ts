// Окно чата в карточке (дизайн §8.7, D-270, D-297): пишущее действие по карточке (чужая = 404, «только чтение» и
// запирающая лицензия — 423), отзыв согласия — 409 без провайдера, пригодность подключения, выбор канала, запрос к
// провайдеру без имени клиента, аудит без ссылки, ссылка не пишется в логи. Сеть — только фикстура fetch.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import { ChatWindowError, openChatWindow, pickChannel, CHAT_WINDOW_RATE } from '../../../src/server/domain/messenger';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as chatRoute from '../../../src/app/api/messenger/chat-window/[cardId]/route';
import { configDoc } from '../../isolation/harness/config';
import { actAs, enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import { INTEGRATION, addChannel, closeMessengerWorld, openMessengerWorld, worldDeps } from './world';

const ORIGIN = 'http://crm.test';
const LINK = 'https://tube.wazzup24.com/iframe/synthetic-one-time-link';
let db: TestDb;
type Call = { url: string; body: unknown; auth: string | null };
let calls: Call[];
let iframeStatus = 200;

const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
  calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>).Authorization ?? null });
  if (url.endsWith('/iframe')) return iframeStatus === 200 ? new Response(JSON.stringify({ link: LINK })) : new Response('{}', { status: iframeStatus });
  return new Response('{}');
};
const deps = (o: Parameters<typeof worldDeps>[0] = {}) => worldDeps({ fetch: fetcher, ...o });

before(async () => {
  db = await openMessengerWorld();
  await addChannel(db.sql, 'ch-wz-op', 'wz-channel-op', U.opA);
});
after(async () => {
  await closeMessengerWorld(db);
});
beforeEach(async () => {
  calls = [];
  iframeStatus = 200;
  await db.sql`UPDATE integrations SET enabled = TRUE, crossborder_approved_at = 1 WHERE id = ${INTEGRATION}`;
  await db.sql`UPDATE messenger_channels SET is_enabled = TRUE`;
  await db.sql`UPDATE client_phones SET kind = 'mobile' WHERE client_id = 'cl-a-1'`;
  await db.sql`DELETE FROM consents WHERE client_id = 'cl-a-1'`;
});

test('сотрудник открывает чат своей карточки: канал владельца, сотрудник у провайдера, запрос без имени клиента', async () => {
  const viewer = await viewerOf(U.opA);
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  let r;
  try {
    r = await openChatWindow(viewer, deps(), { cardId: 'cd-a-1' });
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(r, { url: LINK });
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.endsWith('/users'));
  assert.deepEqual(calls[0]!.body, [{ id: U.opA, name: 'Оператор Синтетик А' }]);
  assert.equal(calls[0]!.auth, 'Bearer synthetic-wazzup-key-0001');
  const iframe = calls[1]!.body as Record<string, unknown>;
  assert.deepEqual(iframe.filter, [{ chatType: 'whatsapp', chatId: '77090000001' }]);
  assert.deepEqual(iframe.activeChat, { channelId: 'wz-channel-op', chatType: 'whatsapp', chatId: '77090000001' }, 'канал владельца карточки, а не общий');
  assert.ok(!JSON.stringify(calls).includes('Синтетика Альфа'), 'имя клиента провайдеру не уходит');
  assert.ok(!logs.join('\n').includes('tube.wazzup24.com'), 'ссылка не пишется в логи');
  const audit = await db.sql<{ actorId: string; entity: string; entityId: string; meta: Record<string, unknown> }>`SELECT actor_id, entity, entity_id, meta FROM audit_log WHERE action = 'messenger.open_chat'`;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], { actorId: U.opA, entity: 'messenger', entityId: 'cd-a-1', meta: { channelId: 'ch-wz-op' } });
  assert.ok(!JSON.stringify(await db.sql`SELECT * FROM audit_log`).includes('wazzup24'), 'ссылки нет в аудите');
});

test('чужая карточка — как несуществующая; РОП видит карточку пространства', async () => {
  await assert.rejects(openChatWindow(await viewerOf(U.opB), deps(), { cardId: 'cd-a-1' }), NotFoundError);
  await assert.rejects(openChatWindow(await viewerOf(U.opA), deps(), { cardId: 'нет-такой' }), NotFoundError);
  assert.equal(calls.length, 0, 'провайдера не трогали');
  const r = await openChatWindow(await viewerOf(U.rop), deps(), { cardId: 'cd-a-1' });
  assert.equal(r.url, LINK);
  const iframe = calls.at(-1)!.body as { activeChat: { channelId: string } };
  assert.equal(iframe.activeChat.channelId, 'wz-channel-op', 'канал владельца карточки и для РОП');
});

test('нет пригодного подключения: выключено, нет решения о передаче, флаг выключен — messenger_unavailable', async () => {
  const v = await viewerOf(U.opA);
  const code = async (d: ReturnType<typeof deps>): Promise<string> => {
    try {
      await openChatWindow(v, d, { cardId: 'cd-a-1' });
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof ChatWindowError);
      return e.code;
    }
  };
  await db.sql`UPDATE integrations SET enabled = FALSE WHERE id = ${INTEGRATION}`;
  assert.equal(await code(deps()), 'messenger_unavailable');
  await db.sql`UPDATE integrations SET enabled = TRUE, crossborder_approved_at = NULL WHERE id = ${INTEGRATION}`;
  assert.equal(await code(deps()), 'messenger_unavailable');
  await db.sql`UPDATE integrations SET crossborder_approved_at = 1 WHERE id = ${INTEGRATION}`;
  assert.equal(await code(deps({ flagOn: () => false })), 'messenger_unavailable');
  assert.equal(await code(deps({ licensed: async () => false })), 'messenger_unavailable');
  assert.equal(calls.length, 0);
});

test('нет мобильного номера → no_phone; нет включённых каналов → no_channel', async () => {
  const v = await viewerOf(U.opA);
  await db.sql`UPDATE client_phones SET kind = 'landline' WHERE client_id = 'cl-a-1'`;
  await assert.rejects(openChatWindow(v, deps(), { cardId: 'cd-a-1' }), (e: unknown) => e instanceof ChatWindowError && e.code === 'no_phone' && e.status === 409);
  await db.sql`UPDATE client_phones SET kind = 'mobile' WHERE client_id = 'cl-a-1'`;
  await db.sql`UPDATE messenger_channels SET is_enabled = FALSE`;
  await assert.rejects(openChatWindow(v, deps(), { cardId: 'cd-a-1' }), (e: unknown) => e instanceof ChatWindowError && e.code === 'no_channel');
});

test('ошибка провайдера → provider_error (502), ссылка не отдаётся', async () => {
  iframeStatus = 400;
  const before = (await db.sql`SELECT 1 FROM audit_log WHERE action = 'messenger.open_chat'`).length;
  await assert.rejects(openChatWindow(await viewerOf(U.opA), deps(), { cardId: 'cd-a-1' }), (e: unknown) => e instanceof ChatWindowError && e.code === 'provider_error' && e.status === 502);
  assert.equal((await db.sql`SELECT 1 FROM audit_log WHERE action = 'messenger.open_chat'`).length, before, 'неудачное открытие в аудит не пишется');
});

test('лимит: 30 открытий в минуту на сотрудника', async () => {
  // Свежий сотрудник (счётчик лимита пуст): оператор-дежурный, карточка на время теста — его
  const v = await viewerOf(U.duty);
  await db.sql`UPDATE cards SET owner_user_id = ${U.duty} WHERE id = 'cd-a-1'`;
  try {
    for (let i = 0; i < CHAT_WINDOW_RATE; i++) await openChatWindow(v, deps(), { cardId: 'cd-a-1' });
    await assert.rejects(openChatWindow(v, deps(), { cardId: 'cd-a-1' }), (e: unknown) => e instanceof ChatWindowError && e.code === 'rate_limited' && e.status === 429);
  } finally {
    await db.sql`UPDATE cards SET owner_user_id = ${U.opA} WHERE id = 'cd-a-1'`;
  }
});

const postWindow = async (as: string | null, cardId: string, origin = true) => {
  actAs(as);
  return chatRoute.POST(new Request(`${ORIGIN}/api/messenger/chat-window/${cardId}`, { method: 'POST', headers: origin ? { origin: ORIGIN } : {} }), {
    params: Promise.resolve({ cardId }),
  });
};

test('маршрут: чужая карточка — 404, выключенное подключение — 409 с кодом, без Origin — 403; ответ не кэшируется', async () => {
  assert.equal((await postWindow(U.opB, 'cd-a-1')).status, 404);
  assert.equal((await postWindow(null, 'cd-a-1')).status, 401);
  assert.equal((await postWindow(U.opA, 'cd-a-1', false)).status, 403);
  assert.equal((await postWindow(U.opA, 'плохой id')).status, 400);
  await db.sql`UPDATE integrations SET enabled = FALSE WHERE id = ${INTEGRATION}`;
  const r = await postWindow(U.opA, 'cd-a-1');
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'messenger_unavailable' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('«только чтение» и запирающая лицензия — 423: ни окна, ни сотрудника у провайдера, ни аудита (D-297)', async () => {
  const audits = async () => (await db.sql`SELECT 1 FROM audit_log WHERE action = 'messenger.open_chat'`).length;
  const before = await audits();
  const dir = await postWindow(U.director, 'cd-a-1');
  assert.equal(dir.status, 423, 'директор видит карточку, но писать клиенту от имени компании не может');
  enterSeedWorld({ license: 'read_only' });
  try {
    assert.equal((await postWindow(U.opA, 'cd-a-1')).status, 423);
  } finally {
    enterSeedWorld();
  }
  assert.equal(calls.length, 0, 'провайдера не трогали: ни /users, ни /iframe');
  assert.equal(await audits(), before);
});

test('роль без права писать (note.write), но с чтением карточки — 404, как у чужой карточки (target: object)', async () => {
  const doc = configDoc() as { global: { roles: Array<{ key: string; readOnly: boolean }> } };
  for (const r of doc.global.roles) if (r.key === 'director') r.readOnly = false;
  enterSeedWorld({ config: doc });
  try {
    const r = await postWindow(U.director, 'cd-a-1');
    assert.equal(r.status, 404);
    assert.equal(calls.length, 0);
  } finally {
    enterSeedWorld();
  }
});

test('согласие отозвано — 409 consent_revoked, номер провайдеру не уходит; новая отметка снова открывает окно', async () => {
  const at = (n: number) => 1_000 + n;
  const H = 'a'.repeat(64);
  await db.sql`INSERT INTO consents (id, client_id, kind, action, at, text_hash, recorded_by, created_at)
               VALUES ('k-1', 'cl-a-1', 'messenger_crossborder', 'given', ${at(1)}, ${H}, ${U.opA}, ${at(1)}),
                      ('k-2', 'cl-a-1', 'messenger_crossborder', 'revoked', ${at(2)}, ${H}, ${U.opA}, ${at(2)})`;
  await assert.rejects(openChatWindow(await viewerOf(U.opA), deps(), { cardId: 'cd-a-1' }), (e: unknown) => e instanceof ChatWindowError && e.code === 'consent_revoked' && e.status === 409);
  const r = await postWindow(U.opA, 'cd-a-1');
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'consent_revoked' });
  assert.equal(calls.length, 0, 'ни /users, ни /iframe: цифры номера за рубеж не ушли');
  await db.sql`INSERT INTO consents (id, client_id, kind, action, at, text_hash, recorded_by, created_at)
               VALUES ('k-3', 'cl-a-1', 'messenger_crossborder', 'given', ${at(3)}, ${H}, ${U.opA}, ${at(3)})`;
  assert.equal((await openChatWindow(await viewerOf(U.opA), deps(), { cardId: 'cd-a-1' })).url, LINK);
});

test('pickChannel: канал владельца карточки, затем сотрудника, затем общий; рабочий — первым', () => {
  const ch = (id: string, owner: string | null, state = 'active') => ({ id, integrationId: 'i', spaceId: 's', providerChannelId: id, ownerUserId: owner, isEnabled: true, state });
  assert.equal(pickChannel([ch('pool', null), ch('mine', 'v'), ch('owner', 'o')], 'o', 'v')?.id, 'owner');
  assert.equal(pickChannel([ch('pool', null), ch('mine', 'v'), ch('other', 'x')], 'o', 'v')?.id, 'mine');
  assert.equal(pickChannel([ch('pool', null), ch('other', 'x')], 'o', 'v')?.id, 'pool');
  assert.equal(pickChannel([ch('other', 'x')], 'o', 'v'), null, 'канал чужого оператора не берём');
  assert.equal(pickChannel([ch('p1', null, 'disabled'), ch('p2', null)], null, 'v')?.id, 'p2');
});
