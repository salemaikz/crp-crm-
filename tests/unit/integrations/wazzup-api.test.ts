// Клиент API Wazzup на подменённом fetch: полный объект подписок, id и имя без телефона, окно чата без имени клиента,
// проверка ссылки iframe, повтор при 429/5xx, коды ошибок, фильтр каналов. Сеть не используется.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../../../src/integrations/contract';
import { createHttp } from '../../../src/integrations/http';
import { wazzupMessenger as p, isWazzupFrameUrl } from '../../../src/integrations/messenger/wazzup';
import { createWazzupApi, WEBHOOK_SUBSCRIPTIONS } from '../../../src/integrations/messenger/wazzup/api';

const channels = readFileSync(new URL('../../integrations/messenger.wazzup/fixtures/channels-list.json', import.meta.url), 'utf8');

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function fake(replies: (Response | Error)[]) {
  const calls: Call[] = [];
  const http = createHttp(['api.wazzup24.com'], async (url, init) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = replies.shift() ?? new Response('{}', { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  });
  const ctx = { integrationId: 'i1', spaceId: 's1', config: {}, secrets: async () => ({ apiKey: 'synthetic-key-0001' }), http, appOrigin: 'https://crm.test', now: 0 } as Ctx<never, never>;
  return { calls, ctx, http };
}
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status });

test('getChannels: Bearer, удалённые отброшены, состояние в нижнем регистре; healthCheck ok / no_channels', async () => {
  const f = fake([new Response(channels), json([])]);
  const r = await p.listChannels!(f.ctx);
  assert.ok(r.ok);
  assert.deepEqual(r.channels.map((c) => [c.transport, c.plainId, c.state]), [['whatsapp', '77091112233', 'active'], ['telegram', 'tg_acme', 'disabled']]);
  assert.equal(f.calls[0]!.url, 'https://api.wazzup24.com/v3/channels');
  assert.equal(f.calls[0]!.headers.Authorization, 'Bearer synthetic-key-0001');
  assert.deepEqual(await p.healthCheck(f.ctx), { ok: false, code: 'no_channels' });
  assert.deepEqual(await p.healthCheck(fake([new Response(channels)]).ctx), { ok: true, code: 'ok' });
});

test('subscribe: PATCH /webhooks с полным объектом подписок', async () => {
  const f = fake([json({})]);
  assert.deepEqual(await p.subscribe!(f.ctx, { webhookUrl: 'https://crm.test/api/hooks/messenger.wazzup/TOKEN' }), { ok: true });
  assert.equal(f.calls[0]!.method, 'PATCH');
  assert.deepEqual(f.calls[0]!.body, { webhooksUri: 'https://crm.test/api/hooks/messenger.wazzup/TOKEN', subscriptions: WEBHOOK_SUBSCRIPTIONS });
  assert.deepEqual(WEBHOOK_SUBSCRIPTIONS, { messagesAndStatuses: true, channelsUpdates: true, contactsAndDealsCreation: false, templateStatus: false });
});

test('syncUsers: только id и имя, без телефона; пустой список — без запроса', async () => {
  const f = fake([json({})]);
  assert.deepEqual(await p.syncUsers!(f.ctx, []), { ok: true });
  assert.equal(f.calls.length, 0);
  await p.syncUsers!(f.ctx, [{ id: 'u-1', name: 'Оператор А', phone: '77090000009' } as { id: string; name: string }]);
  assert.deepEqual(f.calls[0]!.body, [{ id: 'u-1', name: 'Оператор А' }]);
});

test('openChat: запрос без имени клиента, фильтр по номеру, activeChat; ссылка только с домена Wazzup', async () => {
  const input = { user: { id: 'u-1', name: 'Оператор А' }, chat: { chatType: 'whatsapp', chatId: '77090009001', digits: '77090009001' }, channelRef: 'ch-1', text: null };
  const f = fake([json({ link: 'https://tube.wazzup24.com/iframe/abc' })]);
  assert.deepEqual(await p.openChat(f.ctx, input), { kind: 'iframe', url: 'https://tube.wazzup24.com/iframe/abc' });
  const body = f.calls[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.user, { id: 'u-1', name: 'Оператор А' });
  assert.equal(body.scope, 'card');
  assert.deepEqual(body.filter, [{ chatType: 'whatsapp', chatId: '77090009001' }]);
  assert.deepEqual(body.activeChat, { channelId: 'ch-1', chatType: 'whatsapp', chatId: '77090009001' });
  assert.ok(!JSON.stringify(body).includes('Клиент'));
  assert.deepEqual(await p.openChat(fake([json({ link: 'https://evil.example/iframe' })]).ctx, input), { kind: 'error', code: 'rejected' });
  assert.deepEqual(await p.openChat(fake([json({ link: 'http://tube.wazzup24.com/x' })]).ctx, input), { kind: 'error', code: 'rejected' });
  assert.deepEqual(await p.openChat(fake([json({})]).ctx, input), { kind: 'error', code: 'rejected' });
  assert.deepEqual(await p.openChat(f.ctx, { ...input, chat: { ...input.chat, chatType: 'telegram' } }), { kind: 'error', code: 'rejected' });
});

test('isWazzupFrameUrl', () => {
  assert.ok(isWazzupFrameUrl('https://wazzup24.com/x'));
  assert.ok(!isWazzupFrameUrl('https://notwazzup24.com/x'));
  assert.ok(!isWazzupFrameUrl('https://wazzup24.com.evil.test/x'));
  assert.ok(!isWazzupFrameUrl('https://user:pw@tube.wazzup24.com/x'));
  assert.ok(!isWazzupFrameUrl('не адрес'));
});

test('коды ошибок: 401 → auth, 400 → rejected, сеть и 5xx → provider_down; при 429/5xx один повтор', async () => {
  assert.deepEqual(await p.healthCheck(fake([json({}, 401)]).ctx), { ok: false, code: 'auth' });
  assert.deepEqual(await p.healthCheck(fake([json({}, 400)]).ctx), { ok: false, code: 'provider_down' });
  const f = fake([json({}, 503), json({}, 503)]);
  assert.deepEqual(await createWazzupApi(f.http, 'k0000000', { retryDelayMs: 0 }).getChannels(), { ok: false, code: 'provider_down' });
  assert.equal(f.calls.length, 2);
  const g = fake([json({}, 429), new Response(channels)]);
  const ok = await createWazzupApi(g.http, 'k0000000', { retryDelayMs: 0 }).getChannels();
  assert.ok(ok.ok);
  assert.equal(g.calls.length, 2);
  const h = fake([new Error('ECONNRESET'), new Error('ECONNRESET')]);
  assert.deepEqual(await createWazzupApi(h.http, 'k0000000', { retryDelayMs: 0 }).getChannels(), { ok: false, code: 'provider_down' });
});

test('чужой хост запрещён: http без хоста не пускает запрос наружу', async () => {
  const f = fake([]);
  const closed = createHttp([], async () => {
    throw new Error('не должно вызываться');
  });
  const r = await createWazzupApi(closed, 'k0000000', { retryDelayMs: 0 }).getChannels();
  assert.deepEqual(r, { ok: false, code: 'rejected' });
  assert.equal(f.calls.length, 0);
});
