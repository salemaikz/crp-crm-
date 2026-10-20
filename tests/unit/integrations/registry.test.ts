// Реестр плагинов (D-268): уникальность, флаги из FEATURES, manual → tel:, wa_link → wa.me, заготовка Beeline,
// HTTP наружу только на разрешённые хосты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_IDS, type Ctx } from '../../../src/integrations/contract';
import { createHttp, PluginHttpError } from '../../../src/integrations/http';
import { PLUGINS, createRegistry, registry } from '../../../src/integrations/registry';
import { FEATURES } from '../../../src/server/platform/flags';

const ctx = { integrationId: null, spaceId: null, config: {}, secrets: async () => ({}), http: createHttp([]), appOrigin: '', now: 0 } as Ctx<never, never>;
const call = { userId: 'u-1', clientDigits: '77090000001', mode: 'operator-first' as const, correlationId: 'op-1' };

test('каждый плагин в реестре ровно один раз, id из PLUGIN_IDS, флаг — член FEATURES', () => {
  const ids = PLUGINS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PLUGINS) {
    assert.ok((PLUGIN_IDS as readonly string[]).includes(p.id), p.id);
    assert.ok(p.id.startsWith(`${p.kind}.`), p.id);
    if (p.flag) assert.ok((FEATURES as readonly string[]).includes(p.flag), `${p.id}: флаг ${p.flag}`);
  }
  for (const id of ['telephony.manual', 'telephony.beeline', 'messenger.wa_link'] as const) assert.ok(registry.get(id), id);
  assert.equal(registry.telephony('messenger.wa_link'), null);
  assert.equal(registry.messenger('telephony.manual'), null);
  assert.throws(() => createRegistry([PLUGINS[0]!, PLUGINS[0]!]), /дубль/);
});

test('telephony.manual: tel:+7…, добавочный, пустой номер — bad_number', async () => {
  const p = registry.telephony('telephony.manual')!;
  assert.equal(p.capabilities.clickToCall, 'tel');
  assert.deepEqual(await p.initiateCall(ctx, call), { kind: 'tel', href: 'tel:+77090000001' });
  assert.deepEqual(await p.initiateCall(ctx, { ...call, clientDigits: '8 709 000 00 01', ext: '12' }), { kind: 'tel', href: 'tel:+77090000001;ext=12' });
  assert.deepEqual(await p.initiateCall(ctx, { ...call, clientDigits: '' }), { kind: 'error', code: 'bad_number' });
  assert.deepEqual(await p.healthCheck(ctx), { ok: true, code: 'ok' });
});

test('messenger.wa_link: https://wa.me/7…?text=…; без номера — rejected', async () => {
  const p = registry.messenger('messenger.wa_link')!;
  const user = { id: 'u-1', name: 'Оператор' };
  const chat = { chatType: 'whatsapp', chatId: '77090000001', digits: '77090000001' };
  assert.deepEqual(await p.openChat(ctx, { user, chat, channelRef: null, text: 'Добрый день & до встречи' }), {
    kind: 'link',
    href: `https://wa.me/77090000001?text=${encodeURIComponent('Добрый день & до встречи')}`,
  });
  assert.deepEqual(await p.openChat(ctx, { user, chat, channelRef: null, text: null }), { kind: 'link', href: 'https://wa.me/77090000001' });
  assert.deepEqual(await p.openChat(ctx, { user, chat: { ...chat, digits: '' }, channelRef: null, text: null }), { kind: 'error', code: 'rejected' });
});

test('telephony.beeline — заготовка: флаг и лицензия, not_configured, no_endpoint, без вебхука', async () => {
  const p = registry.telephony('telephony.beeline')!;
  assert.equal(p.flag, 'TELEPHONY_BEELINE');
  assert.equal(p.licenseFeature, 'telephony.beeline');
  assert.equal(p.crossBorder, false);
  assert.equal(p.needsConnection, true);
  assert.equal(p.webhook, undefined);
  assert.deepEqual(await p.healthCheck(ctx), { ok: false, code: 'not_configured' });
  assert.deepEqual(await p.initiateCall(ctx, call), { kind: 'error', code: 'no_endpoint' });
  assert.equal(p.configSchema.safeParse({ extra: 1 }).success, false);
});

test('HTTP плагина: только https и только хосты из списка, без редиректов, с таймаутом', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const http = createHttp(['api.example.test'], async (url, init) => (seen.push({ url, init }), new Response('{}')));
  await http.fetch('https://api.example.test/v3/x', { method: 'GET' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.init.redirect, 'error');
  assert.ok(seen[0]!.init.signal instanceof AbortSignal);
  for (const bad of ['http://api.example.test/x', 'https://evil.test/x', 'https://user:pw@api.example.test/x', 'https://api.example.test.evil.test/x', 'не адрес']) {
    await assert.rejects(http.fetch(bad, {}), (e: Error) => e instanceof PluginHttpError && e.message === 'host_not_allowed', bad);
  }
  assert.equal(seen.length, 1);
});
