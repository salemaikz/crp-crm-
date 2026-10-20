// Мир тестов мессенджера: синтетика изоляции + настройки с источником whatsapp_in (вид messenger) + подключение
// Wazzup (включено, решение о передаче за рубеж отмечено) с каналом пространства. Только синтетика (+7 709 …).
import { createHash } from 'node:crypto';
import type { JsonObject } from '@crm/core/config';
import type { MessengerChannelEvent, MessengerMessageEvent, MessengerStatusEvent } from '../../../src/integrations/contract';
import { pluginDeps } from '../../../src/integrations/registry';
import { systemActor } from '../../../src/server/access/systemActor';
import type { IntegrationDeps } from '../../../src/server/domain/integrations';
import { resetChannelRefreshForTests } from '../../../src/server/domain/messenger';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { createHttp } from '../../../src/integrations/http';
import { putIntegrationSecret } from '../../../src/server/platform/secrets';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE } from '../../isolation/harness/seed';
import { worldConfig } from '../clients/world';
import { closeWorld, openWorld } from '../access/world';

export { SEED_NOW, SPACE };
export const NOW = SEED_NOW;
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const INTEGRATION = 'int-wz';
export const CHANNEL = 'ch-wz-1';
export const CHANNEL_REF = 'wz-channel-1';
export const TOKEN = 'wazzup-test-token-0123456789-abcdefghijklmnop';
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const actor = systemActor('webhook_inbox', NOW);

export async function openMessengerWorld(): Promise<TestDb> {
  const db = await openWorld();
  resetConfigCache();
  resetChannelRefreshForTests();
  const cfg = worldConfig();
  const g = cfg.global as Record<string, unknown>;
  (g.sources as JsonObject[]).push({ key: 'whatsapp_in', label: { ru: 'WhatsApp, входящее' }, kind: 'messenger', allowPersonNames: true, detailedReport: false, rejectRules: [], holdRules: [] });
  await writeConfig({ docs: cfg, source: 'cli', authorId: null, project: true, note: 'мессенджер: мир тестов' });
  await db.sql`
    INSERT INTO integrations (id, plugin_id, space_id, config, enabled, webhook_token_hash, crossborder_approved_at, created_at, updated_at)
    VALUES (${INTEGRATION}, 'messenger.wazzup', ${SPACE}, '{}'::jsonb, TRUE, ${sha(TOKEN)}, ${NOW}, ${NOW}, ${NOW})`;
  await putIntegrationSecret(db.sql, { integrationId: INTEGRATION, name: 'apiKey', plaintext: 'synthetic-wazzup-key-0001', now: NOW });
  await addChannel(db.sql, CHANNEL, CHANNEL_REF, null);
  return db;
}

export async function closeMessengerWorld(db: TestDb): Promise<void> {
  resetConfigCache();
  await closeWorld(db);
}

export async function addChannel(sql: Sql, id: string, ref: string, owner: string | null, state = 'active', enabled = true): Promise<void> {
  await sql`
    INSERT INTO messenger_channels (id, integration_id, space_id, provider_channel_id, transport, plain_id, state, owner_user_id, is_enabled, created_at, updated_at)
    VALUES (${id}, ${INTEGRATION}, ${SPACE}, ${ref}, 'whatsapp', '77091112233', ${state}, ${owner}, ${enabled}, ${NOW}, ${NOW})`;
}

/** Зависимости с настоящим реестром, включёнными флагом и лицензией; сеть — только через подмену fetch. */
export function worldDeps(over: Partial<IntegrationDeps> & { fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}): IntegrationDeps {
  const { fetch: f, ...rest } = over;
  const send = f ?? (async () => {
    throw new Error('сеть в тестах не используется');
  });
  return { ...pluginDeps(), http: () => createHttp(['api.wazzup24.com'], send), flagOn: () => true, licensed: async () => true, appOrigin: 'https://crm.test', now: () => NOW, ...rest };
}

export const NEW_NUMBER = '77090000501';

export function msg(over: Partial<MessengerMessageEvent> = {}): MessengerMessageEvent {
  return {
    type: 'message',
    channelRef: CHANNEL_REF,
    chatType: 'whatsapp',
    chatId: NEW_NUMBER,
    chatDigits: NEW_NUMBER,
    providerMessageId: `pm-${Math.random().toString(16).slice(2, 10)}`,
    direction: 'in',
    msgType: 'text',
    text: 'Здравствуйте, это синтетика',
    hasAttachment: false,
    status: null,
    authorRef: null,
    sentAt: NOW,
    isEdited: false,
    isDeleted: false,
    contactName: 'Клиент Синтетик',
    ...over,
  };
}

export const status = (providerMessageId: string, st: MessengerStatusEvent['status'], at = NOW): MessengerStatusEvent => ({ type: 'status', providerMessageId, status: st, at });
export const channelEvent = (state: string, at = NOW, channelRef = CHANNEL_REF): MessengerChannelEvent => ({ type: 'channel', channelRef, state, at });
