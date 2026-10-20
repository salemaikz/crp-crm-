// Подключение Wazzup администратором (дизайн §7.5, §8.3, D-270): ключ шифруется, до решения о передаче за рубеж
// провайдеру уходит только ключ, адрес вебхука не показывается, выключение работает в «только чтение» (D-054).
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginDeps } from '../../../src/integrations/registry';
import { createHttp } from '../../../src/integrations/http';
import {
  checkIntegration,
  connectIntegration,
  disableIntegration,
  enableIntegration,
  IntegrationAdminError,
  listIntegrations,
  patchIntegrationChannel,
  receiveWebhook,
  rotateIntegrationWebhook,
  setIntegrationCrossborder,
  type IntegrationDeps,
} from '../../../src/server/domain/integrations';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as connectRoute from '../../../src/app/api/integrations/connect/route';
import * as listRoute from '../../../src/app/api/integrations/route';
import * as enableRoute from '../../../src/app/api/integrations/[id]/enable/route';
import * as disableRoute from '../../../src/app/api/integrations/[id]/disable/route';
import { actAs, enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { SEED_NOW, U } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from '../access/world';
import { sha } from './helpers';

const ORIGIN = 'http://crm.test';
const KEY = 'synthetic-wazzup-key-9999';
const channels = readFileSync(new URL('../../integrations/messenger.wazzup/fixtures/channels-list.json', import.meta.url), 'utf8');

let db: TestDb;
type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let webhookTokenSeenByProvider: string | null = null;
let patchStatus = 200;

const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
  const path = new URL(url).pathname.replace('/v3', '');
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: String(init.method), path, body });
  if (path === '/channels') return new Response(channels);
  if (path === '/webhooks') {
    // Провайдер сразу присылает тест по адресу: токен уже должен быть в БД
    const token = String(body.webhooksUri).split('/').pop() as string;
    const rows = await db.sql`SELECT 1 FROM integrations WHERE webhook_token_hash = ${sha(token)}`;
    webhookTokenSeenByProvider = rows.length === 1 ? token : null;
    return patchStatus === 200 ? new Response('{}') : new Response('{}', { status: patchStatus });
  }
  return new Response('{}');
};
const deps = (o: Partial<IntegrationDeps> = {}): IntegrationDeps => ({
  ...pluginDeps(),
  http: () => createHttp(['api.wazzup24.com'], fetcher),
  flagOn: () => true,
  licensed: async () => true,
  appOrigin: 'https://crm.test',
  now: () => SEED_NOW,
  ...o,
});
const row = async () => (await db.sql<{ id: string; enabled: boolean; hash: string | null; approved: number | null; status: string; spaceId: string | null }>`
  SELECT id, enabled, webhook_token_hash AS hash, crossborder_approved_at AS approved, status, space_id FROM integrations WHERE plugin_id = 'messenger.wazzup'`)[0];

before(async () => {
  db = await openWorld();
});
after(async () => {
  await closeWorld(db);
});
beforeEach(() => {
  calls = [];
  webhookTokenSeenByProvider = null;
  patchStatus = 200;
});

const failure = async (p: Promise<unknown>, code: string, status: number): Promise<void> => {
  await assert.rejects(p, (e: unknown) => e instanceof IntegrationAdminError && e.code === code && e.status === status, `${code}/${status}`);
};

test('подключение: ключ шифруется, каналы компании сохранены, статус ok; ключа нет ни в ответе, ни в аудите', async () => {
  const admin = await viewerOf(U.admin);
  const r = await connectIntegration(admin, deps(), { pluginId: 'messenger.wazzup', apiKey: KEY });
  assert.deepEqual({ status: r.status, channels: r.channels }, { status: 'ok', channels: 2 });
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.deepEqual(calls.map((c) => c.path), ['/channels', '/channels'], 'только проверка ключа и список каналов: ни подписки, ни сотрудников');
  const i = await row();
  assert.equal(i?.enabled, false);
  assert.equal(i?.spaceId, 'sp-sales');
  const secret = (await db.sql<{ ciphertext: Buffer; last4: string }>`SELECT ciphertext, last4 FROM integration_secrets WHERE integration_id = ${i!.id} AND name = 'apiKey'`)[0];
  assert.equal(secret?.last4, '9999');
  assert.ok(!secret!.ciphertext.toString('utf8').includes('synthetic-wazzup-key'), 'в БД не открытый ключ');
  const ch = await db.sql<{ transport: string; plainId: string | null }>`SELECT transport, plain_id FROM messenger_channels WHERE integration_id = ${i!.id} ORDER BY transport`;
  assert.deepEqual(ch, [{ transport: 'telegram', plainId: 'tg_acme' }, { transport: 'whatsapp', plainId: '77091112233' }]);
  const audit = await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'integration.connect'`;
  assert.deepEqual(audit[0]?.meta, { pluginId: 'messenger.wazzup', status: 'ok', channels: 2 });
});

test('включение без отметки решения о передаче за рубеж — 409, провайдера не трогаем', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  await failure(enableIntegration(admin, deps(), id), 'crossborder_not_approved', 409);
  assert.equal(calls.length, 0);
  assert.equal((await row())?.enabled, false);
});

test('решение отмечено → включение: адрес вебхука в БД до теста провайдера, подписка, сотрудники без телефонов, enabled', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  assert.deepEqual(await setIntegrationCrossborder(admin, deps(), id, { approved: true, decisionDate: '2026-10-27' }), { id, approved: true });
  const r = await enableIntegration(admin, deps(), id);
  assert.deepEqual(r, { id, enabled: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PATCH /webhooks', 'POST /users']);
  const patch = calls[0]!.body as { webhooksUri: string; subscriptions: Record<string, boolean> };
  assert.match(patch.webhooksUri, /^https:\/\/crm\.test\/api\/hooks\/messenger\.wazzup\/[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(patch.subscriptions, { messagesAndStatuses: true, channelsUpdates: true, contactsAndDealsCreation: false, templateStatus: false });
  const token = patch.webhooksUri.split('/').pop() as string;
  assert.equal(webhookTokenSeenByProvider, token, 'провайдер при подписке уже находит подключение по токену');
  assert.equal((await row())?.hash, sha(token));
  const users = calls[1]!.body as { id: string; name: string }[];
  assert.ok(users.length >= 8 && users.every((u) => Object.keys(u).sort().join() === 'id,name'));
  assert.ok(users.some((u) => u.id === U.opA && u.name === 'Оператор Синтетик А'));
  assert.ok(!users.some((u) => u.id === U.disabled), 'отключённые сотрудники не выгружаются');
  const text = JSON.stringify(await db.sql`SELECT * FROM audit_log`);
  assert.ok(!text.includes(token) && !text.includes('/api/hooks/'), 'токена и адреса вебхука нет в аудите');
  assert.ok(!JSON.stringify(r).includes(token));
  // Тест провайдера и событие по этому токену проходят общий приём
  const ping = await receiveWebhook(deps(), { pluginId: 'messenger.wazzup', token, req: new Request('https://crm.test/x', { method: 'POST', body: '{"test":true}' }) });
  assert.equal(ping.status, 200);
});

test('перевыпуск адреса: старый токен перестаёт работать, новый работает, подписка повторяется', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  const oldHash = (await row())!.hash;
  await rotateIntegrationWebhook(admin, deps(), id);
  const patch = calls.at(-1)!;
  assert.equal(patch.path, '/webhooks');
  const fresh = String((patch.body as { webhooksUri: string }).webhooksUri).split('/').pop() as string;
  assert.notEqual(sha(fresh), oldHash);
  assert.equal((await row())?.hash, sha(fresh));
  const post = (token: string) => receiveWebhook(deps(), { pluginId: 'messenger.wazzup', token, req: new Request('https://crm.test/x', { method: 'POST', body: '{"test":true}' }) });
  assert.equal((await post(fresh)).status, 200);
  assert.equal((await post('a'.repeat(43))).status, 404);
});

test('ошибка провайдера при подписке: 502, подключение выключено, адрес сброшен', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  await disableIntegration(admin, deps(), id);
  patchStatus = 400;
  await failure(enableIntegration(admin, deps(), id), 'provider_error', 502);
  const i = await row();
  assert.equal(i?.enabled, false);
  assert.equal(i?.hash, null);
  patchStatus = 200;
  await enableIntegration(admin, deps(), id);
  assert.equal((await row())?.enabled, true);
});

test('снятие отметки о решении выключает подключение; выключение пишет аудит', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  await setIntegrationCrossborder(admin, deps(), id, { approved: false, decisionDate: '2026-10-28' });
  const i = await row();
  assert.equal(i?.enabled, false);
  assert.equal(i?.approved, null);
  const actions = (await db.sql<{ action: string }>`SELECT action FROM audit_log WHERE entity = 'integration' ORDER BY created_at, id`).map((r) => r.action);
  assert.ok(actions.includes('integration.crossborder') && actions.includes('integration.enable') && actions.includes('integration.revoke_webhook'));
  await setIntegrationCrossborder(admin, deps(), id, { approved: true, decisionDate: '2026-10-28' });
  await disableIntegration(admin, deps(), id);
  assert.ok((await db.sql`SELECT 1 FROM audit_log WHERE action = 'integration.disable'`).length >= 1);
});

test('каналы: владелец — активный сотрудник пространства; общий канал (null); включение', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  const [wa] = await db.sql<{ id: string }>`SELECT id FROM messenger_channels WHERE integration_id = ${id} AND transport = 'whatsapp'`;
  assert.equal((await patchIntegrationChannel(admin, deps(), { integrationId: id, channelId: wa!.id, ownerUserId: U.opA })).ownerUserId, U.opA);
  await failure(patchIntegrationChannel(admin, deps(), { integrationId: id, channelId: wa!.id, ownerUserId: U.disabled }), 'bad_owner', 400);
  await failure(patchIntegrationChannel(admin, deps(), { integrationId: id, channelId: 'нет', isEnabled: false }), 'not_found', 404);
  const off = await patchIntegrationChannel(admin, deps(), { integrationId: id, channelId: wa!.id, ownerUserId: null, isEnabled: false });
  assert.deepEqual({ owner: off.ownerUserId, enabled: off.isEnabled }, { owner: null, enabled: false });
  const meta = (await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'integration.channel' ORDER BY created_at DESC, id DESC LIMIT 1`)[0]!.meta;
  assert.equal(meta.channelId, wa!.id);
});

test('проверка ключа обновляет статус и каналы; плохой ключ — статус auth', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  assert.equal((await checkIntegration(admin, deps(), id)).status, 'ok');
  const bad = deps({ http: () => createHttp(['api.wazzup24.com'], async () => new Response('{}', { status: 401 })) });
  assert.equal((await checkIntegration(admin, bad, id)).status, 'auth');
  assert.equal((await row())?.status, 'auth');
});

test('новый ключ: подключение выключается, адрес вебхука сбрасывается', async () => {
  const admin = await viewerOf(U.admin);
  const id = (await row())!.id;
  await connectIntegration(admin, deps(), { pluginId: 'messenger.wazzup', apiKey: 'another-synthetic-key-0002' });
  const i = await row();
  assert.deepEqual({ id: i?.id, enabled: i?.enabled, hash: i?.hash }, { id, enabled: false, hash: null });
  assert.equal((await db.sql<{ last4: string }>`SELECT last4 FROM integration_secrets WHERE integration_id = ${id}`)[0]?.last4, '0002');
});

test('флаг выключен — 404, нет признака в лицензии — 403; неподключаемый плагин — 404; список скрывает подключение при выключенном флаге', async () => {
  const admin = await viewerOf(U.admin);
  await failure(connectIntegration(admin, deps({ flagOn: () => false }), { pluginId: 'messenger.wazzup', apiKey: KEY }), 'not_found', 404);
  await failure(connectIntegration(admin, deps({ licensed: async () => false }), { pluginId: 'messenger.wazzup', apiKey: KEY }), 'not_licensed', 403);
  await failure(connectIntegration(admin, deps(), { pluginId: 'telephony.manual', apiKey: KEY }), 'not_found', 404);
  await failure(connectIntegration(admin, deps(), { pluginId: 'telephony.beeline', apiKey: KEY }), 'not_found', 404);
  const on = await listIntegrations(admin, deps());
  const wz = on.find((p) => p.pluginId === 'messenger.wazzup');
  assert.equal(wz?.flagOn, true);
  assert.equal(wz?.connection?.secrets[0]?.last4, '0002');
  assert.ok(wz?.connection?.channels.length === 2);
  assert.ok(!JSON.stringify(on).includes('another-synthetic-key'));
  assert.ok(!JSON.stringify(on).includes('webhook'), 'адрес вебхука в список не попадает');
  const off = await listIntegrations(admin, deps({ flagOn: () => false }));
  assert.equal(off.find((p) => p.pluginId === 'messenger.wazzup')?.flagOn, false);
  assert.equal(off.find((p) => p.pluginId === 'messenger.wazzup')?.connection, null);
});

test('маршруты: только администратор; «только чтение» блокирует подключение, но не выключение (D-054)', async () => {
  type H = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
  const call = async (h: H, method: string, as: string | null, params: Record<string, string> = {}, body?: unknown) => {
    actAs(as);
    return h(new Request(`${ORIGIN}/api/integrations`, { method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve(params) });
  };
  assert.equal((await call(listRoute.GET, 'GET', U.opA)).status, 403);
  assert.equal((await call(listRoute.GET, 'GET', U.rop)).status, 403);
  assert.equal((await call(listRoute.GET, 'GET', null)).status, 401);
  const list = await call(listRoute.GET, 'GET', U.admin);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal((await call(connectRoute.POST, 'POST', U.opA, {}, { pluginId: 'messenger.wazzup', apiKey: KEY })).status, 403);
  assert.equal((await call(connectRoute.POST, 'POST', U.admin, {}, { pluginId: 'messenger.wazzup', apiKey: 'short' })).status, 400);
  assert.equal((await call(connectRoute.POST, 'POST', U.admin, {}, { pluginId: 'messenger.wazzup', apiKey: KEY, extra: 1 })).status, 400);
  const id = (await row())!.id;
  await db.sql`UPDATE integrations SET enabled = TRUE WHERE id = ${id}`;
  enterSeedWorld({ license: 'read_only' });
  try {
    assert.equal((await call(enableRoute.POST, 'POST', U.admin, { id })).status, 423, 'включение — мутация, лицензия её блокирует');
    assert.equal((await call(connectRoute.POST, 'POST', U.admin, {}, { pluginId: 'messenger.wazzup', apiKey: KEY })).status, 423);
    const off = await call(disableRoute.POST, 'POST', U.admin, { id });
    assert.equal(off.status, 200, 'выключение работает при любой лицензии');
    assert.equal((await row())?.enabled, false);
  } finally {
    enterSeedWorld();
  }
});
