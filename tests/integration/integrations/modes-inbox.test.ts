// Режимы каналов (D-268, §7.3) и обработка webhook_inbox воркером (§7.7): parse() плагина → применитель вида,
// чистка payload через 14 дней.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer, SystemActor } from '../../../src/server/access';
import { pluginUsability } from '../../../src/integrations/enablement';
import { createRegistry, PLUGINS } from '../../../src/integrations/registry';
import { FALLBACK_MODES, getChannelModes, purgeWebhookPayloads } from '../../../src/server/domain/integrations';
import { webhookHandlers, type InboxApplier } from '../../../src/server/jobs/integrations';
import { purgeParts, queueSpecs } from '../../../src/server/jobs/registry';
import { jsonParam } from '../../../src/server/platform/db/core';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { T0, deps, fakeRegistry, insertIntegration } from './helpers';

let db: TestDb;
const viewer = (spaceId: string | null) => ({ spaceId }) as unknown as Viewer;
const actor = { kind: 'system', job: 'test', now: T0 } as SystemActor;
const DAY = 86_400_000;

before(async () => {
  db = await createTestDb();
  await db.sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES ('sp-1', 'sales', TRUE, ${T0}), ('sp-2', 'other', FALSE, ${T0})`;
});
after(async () => {
  await db.close();
});

test('без подключений — запасной режим (tel:, wa.me); без пространства — тоже', async () => {
  assert.deepEqual(await getChannelModes(viewer('sp-1'), deps()), FALLBACK_MODES);
  assert.deepEqual(await getChannelModes(viewer(null), deps()), FALLBACK_MODES);
});

test('телефония: включённая пригодная Beeline пространства → её режим; флаг, лицензия, чужое пространство — запасной', async () => {
  await insertIntegration(db.sql, { id: 'tel-1', pluginId: 'telephony.beeline', spaceId: 'sp-1', enabled: true, approved: false, token: null });
  const on = await getChannelModes(viewer('sp-1'), deps());
  assert.deepEqual(on.telephony, { pluginId: 'telephony.beeline', clickToCall: 'callback' });
  assert.deepEqual(on.messenger, FALLBACK_MODES.messenger);
  assert.deepEqual((await getChannelModes(viewer('sp-1'), deps({ flagOn: () => false }))).telephony, FALLBACK_MODES.telephony);
  assert.deepEqual((await getChannelModes(viewer('sp-1'), deps({ licensed: async () => false }))).telephony, FALLBACK_MODES.telephony);
  assert.deepEqual((await getChannelModes(viewer('sp-2'), deps())).telephony, FALLBACK_MODES.telephony);
  // реестр продукта: флаг Beeline по окружению, лицензии в тестовой установке нет — запасной режим
  const product = await getChannelModes(viewer('sp-1'), { registry: createRegistry(PLUGINS), usability: pluginUsability, http: deps().http });
  assert.deepEqual(product, FALLBACK_MODES);
  await db.sql`UPDATE integrations SET enabled = FALSE WHERE id = 'tel-1'`;
  assert.deepEqual((await getChannelModes(viewer('sp-1'), deps())).telephony, FALLBACK_MODES.telephony);
});

test('мессенджер: окно провайдера только при пригодном подключении и включённом канале пространства', async () => {
  await insertIntegration(db.sql, { id: 'msg-1', spaceId: null, enabled: true, token: null });
  assert.deepEqual((await getChannelModes(viewer('sp-1'), deps())).messenger, FALLBACK_MODES.messenger, 'каналов нет');
  await db.sql`
    INSERT INTO messenger_channels (id, integration_id, space_id, provider_channel_id, transport, state, is_enabled, created_at, updated_at)
    VALUES ('ch-1', 'msg-1', 'sp-1', 'synthetic-channel-1', 'whatsapp', 'active', TRUE, ${T0}, ${T0})`;
  assert.deepEqual((await getChannelModes(viewer('sp-1'), deps())).messenger, { pluginId: 'messenger.wazzup', chat: 'iframe' });
  assert.deepEqual((await getChannelModes(viewer('sp-2'), deps())).messenger, FALLBACK_MODES.messenger, 'канал другого пространства');
  await db.sql`UPDATE integrations SET crossborder_approved_at = NULL WHERE id = 'msg-1'`;
  assert.deepEqual((await getChannelModes(viewer('sp-1'), deps())).messenger, FALLBACK_MODES.messenger, 'нет отметки решения');
});

test('очередь: обработчик только у плагина с вебхуком и применителем; parse → применитель; пусто — done', async () => {
  assert.deepEqual([...webhookHandlers().keys()], ['messenger.wazzup'], 'у плагинов продукта вебхук только у Wazzup (O7a)');
  assert.equal(webhookHandlers(fakeRegistry, {}).size, 0, 'нет применителя — нет обработчика (retry no_handler)');
  const seen: unknown[] = [];
  const apply: InboxApplier = async (_a, input) => (seen.push(input), { status: 'done' });
  const handlers = webhookHandlers(fakeRegistry, { messenger: apply });
  assert.deepEqual([...handlers.keys()], ['messenger.wazzup']);
  await insertIntegration(db.sql, { id: 'hook-1', token: null });
  await db.sql`
    INSERT INTO webhook_inbox (id, integration_id, dedupe_key, kind, payload, next_at, received_at) VALUES
      ('w-1', 'hook-1', 'e:1', 'status', ${jsonParam({ id: 'm1', kind: 'status' })}, ${T0}, ${T0 - 15 * DAY}),
      ('w-2', 'hook-1', 'e:2', 'message', '{"id":"m2","kind":"message"}', ${T0}, ${T0}),
      ('w-3', 'hook-1', 'e:3', 'status', NULL, ${T0}, ${T0})`;
  const h = handlers.get('messenger.wazzup')!;
  const signal = new AbortController().signal;
  assert.deepEqual(await h(actor, { id: 'w-1', handlerKey: 'messenger.wazzup', kind: 'status', attempt: 1 }, signal), { status: 'done' });
  assert.deepEqual(seen, [{ integrationId: 'hook-1', pluginId: 'messenger.wazzup', kind: 'status', events: [{ type: 'status', providerMessageId: 'm1', status: 'delivered', at: T0 }], attempt: 1 }]);
  assert.deepEqual(await h(actor, { id: 'w-2', handlerKey: 'messenger.wazzup', kind: 'message', attempt: 1 }, signal), { status: 'done' });
  assert.equal(seen.length, 1, 'нет событий — применитель не зовётся');
  assert.deepEqual(await h(actor, { id: 'w-3', handlerKey: 'messenger.wazzup', kind: 'status', attempt: 1 }, signal), { status: 'failed', error: 'payload_purged' });
  assert.deepEqual(await h(actor, { id: 'w-none', handlerKey: 'messenger.wazzup', kind: 'status', attempt: 1 }, signal), { status: 'failed', error: 'missing' });
});

test('чистка: payload старше 14 дней обнуляется, строки остаются; часть purge и очередь в реестре воркера', async () => {
  assert.equal(await purgeWebhookPayloads(actor, T0 - 14 * DAY), 1);
  const rows = await db.sql<{ id: string; hasPayload: boolean }>`SELECT id, payload IS NOT NULL AS has_payload FROM webhook_inbox ORDER BY id`;
  assert.deepEqual(rows, [{ id: 'w-1', hasPayload: false }, { id: 'w-2', hasPayload: true }, { id: 'w-3', hasPayload: false }]);
  assert.ok(purgeParts.some((p) => p.key === 'webhook_payload'));
  assert.ok(queueSpecs().some((q) => q.name === 'webhook_inbox'));
});
