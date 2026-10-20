// Весь SQL мессенджера (O7a): каналы, чаты, сообщения, получатели уведомлений, окно чата, согласие.
// Применение событий — служебное (воркер, SystemActor, охвата нет намеренно: событие провайдера не от сотрудника);
// окно чата и согласие читают только через scopeSql. ПДн (текст сообщений, номера чатов) — только в своих колонках.
import type { Actor, Viewer } from '@/server/access';
import { scopeSql, scoped } from '@/server/access/scope';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import type { MessengerChannelInfo } from '@/integrations/contract';

// ---------------------------------------------------------------------------
// Подключение и каналы
// ---------------------------------------------------------------------------

export interface IntegrationHead {
  id: string;
  pluginId: string;
  /** Пространство подключения; для подключения на всю установку — пространство по умолчанию. */
  spaceId: string;
  config: unknown;
  enabled: boolean;
}

/** Подключение под блокировкой FOR SHARE: «Выключить» не проскочит между проверкой и записью. */
export async function lockIntegration(tx: Sql, id: string): Promise<IntegrationHead | null> {
  const [row] = await tx<IntegrationHead>`
    SELECT i.id, i.plugin_id, COALESCE(i.space_id, (SELECT s.id FROM spaces s WHERE s.is_default ORDER BY s.created_at LIMIT 1)) AS space_id,
           i.config, i.enabled
      FROM integrations i WHERE i.id = ${id} FOR SHARE`;
  return row ?? null;
}

export interface ChannelRow {
  id: string;
  integrationId: string;
  spaceId: string;
  providerChannelId: string;
  ownerUserId: string | null;
  isEnabled: boolean;
  state: string;
}

export async function findChannel(sql: Sql, a: { integrationId: string; ref: string }): Promise<ChannelRow | null> {
  const [row] = await sql<ChannelRow>`
    SELECT id, integration_id, space_id, provider_channel_id, owner_user_id, is_enabled, state
      FROM messenger_channels WHERE integration_id = ${a.integrationId} AND provider_channel_id = ${a.ref}`;
  return row ?? null;
}

export async function listChannels(sql: Sql, integrationId: string): Promise<(ChannelRow & { transport: string; plainId: string | null; stateChangedAt: number | null })[]> {
  return sql`
    SELECT id, integration_id, space_id, provider_channel_id, owner_user_id, is_enabled, state, transport, plain_id, state_changed_at
      FROM messenger_channels WHERE integration_id = ${integrationId} ORDER BY transport, provider_channel_id`;
}

/** Каналы компании от провайдера: новые добавляются, известные обновляются; привязка к оператору и «включён» не трогаются. */
export async function upsertChannels(sql: Sql, a: { integrationId: string; spaceId: string; channels: readonly MessengerChannelInfo[]; now: number }): Promise<number> {
  let n = 0;
  for (const c of a.channels) {
    const rows = await sql<{ id: string }>`
      INSERT INTO messenger_channels (id, integration_id, space_id, provider_channel_id, transport, plain_id, state, state_changed_at, created_at, updated_at)
      VALUES (${newId()}, ${a.integrationId}, ${a.spaceId}, ${c.channelRef}, ${c.transport}, ${c.plainId}, ${c.state}, ${a.now}, ${a.now}, ${a.now})
      ON CONFLICT (integration_id, provider_channel_id) DO UPDATE
        SET transport = EXCLUDED.transport, plain_id = EXCLUDED.plain_id, updated_at = EXCLUDED.updated_at
      RETURNING id`;
    n += rows.length;
  }
  return n;
}

/** Состояние от провайдера; устаревшее событие (раньше записанного) не применяется. Возвращает true, если применено. */
export async function setChannelState(sql: Sql, a: { id: string; state: string; at: number; now: number }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE messenger_channels SET state = ${a.state}, state_changed_at = ${a.at}, updated_at = ${a.now}
     WHERE id = ${a.id} AND (state_changed_at IS NULL OR state_changed_at <= ${a.at}) RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Чаты и сообщения
// ---------------------------------------------------------------------------

export interface ChatRow {
  id: string;
  clientId: string | null;
}

export async function upsertChat(sql: Sql, a: { channelId: string; chatType: string; chatId: string; now: number }): Promise<ChatRow> {
  const [row] = await sql<ChatRow>`
    INSERT INTO messenger_chats (id, channel_id, chat_type, chat_id, created_at)
    VALUES (${newId()}, ${a.channelId}, ${a.chatType}, ${a.chatId}, ${a.now})
    ON CONFLICT (channel_id, chat_type, chat_id) DO UPDATE SET chat_id = EXCLUDED.chat_id
    RETURNING id, client_id`;
  return row as ChatRow;
}

export async function setChatClient(sql: Sql, chatRef: string, clientId: string): Promise<void> {
  await sql`UPDATE messenger_chats SET client_id = ${clientId} WHERE id = ${chatRef} AND client_id IS NULL`;
}

export async function touchChat(sql: Sql, a: { chatRef: string; at: number; inbound: boolean; awaitingReply: boolean | null }): Promise<void> {
  await sql`
    UPDATE messenger_chats SET
      last_message_at = GREATEST(COALESCE(last_message_at, 0), ${a.at}),
      last_inbound_at = CASE WHEN ${a.inbound} THEN GREATEST(COALESCE(last_inbound_at, 0), ${a.at}) ELSE last_inbound_at END,
      awaiting_reply  = COALESCE(${a.awaitingReply}::boolean, awaiting_reply)
     WHERE id = ${a.chatRef}`;
}

export interface MessageIn {
  integrationId: string;
  chatRef: string;
  providerMessageId: string;
  direction: 'in' | 'out';
  msgType: string;
  body: string | null;
  hasAttachment: boolean;
  status: string | null;
  authorRef: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  sentAt: number;
  now: number;
}

/**
 * Сообщение по (integration_id, provider_message_id): вебхук о нашем исходящем может прийти раньше ответа API, а
 * правка и удаление приходят с тем же id. Удаление обнуляет текст и остаётся навсегда; правка заменяет текст.
 */
export async function upsertMessage(sql: Sql, m: MessageIn): Promise<{ id: string; inserted: boolean; authorUserId: string | null }> {
  const [row] = await sql<{ id: string; inserted: boolean; authorUserId: string | null }>`
    INSERT INTO messenger_messages (id, integration_id, chat_ref, provider_message_id, direction, msg_type, body, has_attachment, status,
                                    author_user_id, is_edited, is_deleted, sent_at, status_at, created_at)
    VALUES (${newId()}, ${m.integrationId}, ${m.chatRef}, ${m.providerMessageId}, ${m.direction}, ${m.msgType},
            ${m.isDeleted ? null : m.body}, ${m.hasAttachment}, ${m.status},
            (SELECT u.id FROM users u WHERE u.id = ${m.authorRef}::text), ${m.isEdited}, ${m.isDeleted}, ${m.sentAt},
            ${m.status ? m.sentAt : null}, ${m.now})
    ON CONFLICT (integration_id, provider_message_id) DO UPDATE SET
      is_edited = messenger_messages.is_edited OR EXCLUDED.is_edited,
      is_deleted = messenger_messages.is_deleted OR EXCLUDED.is_deleted,
      body = CASE WHEN messenger_messages.is_deleted OR EXCLUDED.is_deleted THEN NULL
                  WHEN EXCLUDED.is_edited THEN EXCLUDED.body ELSE messenger_messages.body END,
      status = COALESCE(EXCLUDED.status, messenger_messages.status)
    RETURNING id, (xmax = 0) AS inserted, author_user_id`;
  return row as { id: string; inserted: boolean; authorUserId: string | null };
}

/** Статус доставки; устаревший (раньше записанного) не применяется. 0 строк — сообщения ещё нет (или статус старый). */
export async function applyStatus(sql: Sql, a: { integrationId: string; providerMessageId: string; status: string; at: number }): Promise<{ found: boolean }> {
  const rows = await sql<{ id: string }>`
    UPDATE messenger_messages SET
      status = CASE WHEN status_at IS NULL OR status_at <= ${a.at} THEN ${a.status} ELSE status END,
      status_at = CASE WHEN status_at IS NULL OR status_at <= ${a.at} THEN ${a.at} ELSE status_at END
     WHERE integration_id = ${a.integrationId} AND provider_message_id = ${a.providerMessageId}
     RETURNING id`;
  return { found: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Карточка, получатели, лимиты
// ---------------------------------------------------------------------------

export interface CardHead {
  id: string;
  state: string;
  ownerUserId: string | null;
  actingUserId: string | null;
}

export async function cardOf(sql: Sql, a: { clientId: string; spaceId: string }): Promise<CardHead | null> {
  const [row] = await sql<CardHead>`SELECT id, state, owner_user_id, acting_user_id FROM cards WHERE client_id = ${a.clientId} AND space_id = ${a.spaceId}`;
  return row ?? null;
}

/** РОП пространства для задач: первый по (имя, id) активный сотрудник с ролью `distribution.inbound.offHours`. */
export async function leadUser(sql: Sql, a: { spaceId: string; role: string }): Promise<string | null> {
  const [row] = await sql<{ userId: string }>`
    SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND m.role_key = ${a.role}
     ORDER BY u.name, u.id LIMIT 1`;
  return row?.userId ?? null;
}

export async function adminIds(sql: Sql): Promise<string[]> {
  return (await sql<{ id: string }>`SELECT id FROM users WHERE is_admin AND status = 'active' ORDER BY id`).map((r) => r.id);
}

export async function userIdsByRoles(sql: Sql, a: { spaceId: string; roles: readonly string[] }): Promise<string[]> {
  if (a.roles.length === 0) return [];
  const rows = await sql<{ userId: string }>`
    SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND m.role_key = ANY(${[...a.roles]}::text[]) ORDER BY m.user_id`;
  return rows.map((r) => r.userId);
}

/** Уведомление по ключу идемпотентности (`dedupe_key`): повтор ничего не меняет. params — только коды и числа. */
export async function insertNotice(
  sql: Sql,
  a: { userId: string; kind: string; entityType: string; entityId: string; params: Record<string, number | string>; dedupeKey: string; now: number },
): Promise<void> {
  await sql`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${a.userId}, ${a.kind}, ${a.entityType}, ${a.entityId}, ${jsonParam(a.params)}, ${a.dedupeKey}, ${a.now}, ${a.now})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

/** Задачи «Ответить» по подключению с момента `since` (суточный предел против залива). */
export async function countReplyTasksSince(sql: Sql, a: { integrationId: string; since: number }): Promise<number> {
  const [r] = await sql<{ n: number }>`
    SELECT count(*)::int AS n
      FROM tasks t
      JOIN messenger_chats mc ON t.source_key = 'reply:' || mc.id
      JOIN messenger_channels ch ON ch.id = mc.channel_id
     WHERE ch.integration_id = ${a.integrationId} AND t.source = 'inbound_message' AND t.created_at >= ${a.since}`;
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Окно чата (охват scopeSql)
// ---------------------------------------------------------------------------

export interface ChatCard {
  id: string;
  clientId: string;
  spaceId: string;
  ownerUserId: string | null;
  actingUserId: string | null;
}

/** Карточка, видимая сотруднику (`card.read`); чужая = несуществующая. */
export async function visibleCard(viewer: Viewer, sql: Sql, cardId: string): Promise<ChatCard | null> {
  const [row] = await scoped(sql)<ChatCard>`
    SELECT c.id, c.client_id, c.space_id, c.owner_user_id, c.acting_user_id
      FROM cards c WHERE c.id = ${cardId} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  return row ?? null;
}

/** Основной рабочий мобильный номер клиента, видимый роли. */
export async function workingMobile(viewer: Viewer, sql: Sql, clientId: string): Promise<string | null> {
  const [row] = await scoped(sql)<{ digits: string }>`
    SELECT cp.digits FROM client_phones cp
     WHERE cp.client_id = ${clientId} AND cp.is_working AND cp.kind = 'mobile' AND ${scopeSql(viewer, 'client_phone', 'client.read')}
     ORDER BY cp.is_primary DESC, cp.created_at, cp.id LIMIT 1`;
  return row?.digits ?? null;
}

export async function viewerName(sql: Sql, userId: string): Promise<string> {
  const [row] = await sql<{ name: string }>`SELECT name FROM users WHERE id = ${userId}`;
  return row?.name ?? '';
}

/** Включённые каналы подключения в пространстве: владелец канала, состояние. */
export async function enabledChannels(sql: Sql, a: { integrationId: string; spaceId: string }): Promise<ChannelRow[]> {
  return sql<ChannelRow>`
    SELECT id, integration_id, space_id, provider_channel_id, owner_user_id, is_enabled, state
      FROM messenger_channels WHERE integration_id = ${a.integrationId} AND space_id = ${a.spaceId} AND is_enabled
     ORDER BY provider_channel_id`;
}

// ---------------------------------------------------------------------------
// Согласие клиента (consents)
// ---------------------------------------------------------------------------

/** Клиент, которого сотрудник может править (`client.edit`); чужой = несуществующий. */
export async function editableClient(viewer: Viewer, sql: Sql, clientId: string): Promise<{ id: string } | null> {
  const [row] = await scoped(sql)<{ id: string }>`
    SELECT cl.id FROM clients cl WHERE cl.id = ${clientId} AND cl.merged_into_id IS NULL AND ${scopeSql(viewer, 'client', 'client.edit')}`;
  return row ?? null;
}

export async function insertConsent(sql: Sql, a: { clientId: string; action: 'given' | 'revoked'; textHash: string; recordedBy: string; at: number }): Promise<void> {
  await sql`
    INSERT INTO consents (id, client_id, kind, action, at, text_hash, recorded_by, created_at)
    VALUES (${newId()}, ${a.clientId}, 'messenger_crossborder', ${a.action}, ${a.at}, ${a.textHash}, ${a.recordedBy}, ${a.at})`;
}

/** Последняя отметка согласия на переписку за рубежом: `given`, `revoked` или null. */
export async function lastConsent(viewer: Viewer, sql: Sql, clientId: string): Promise<'given' | 'revoked' | null> {
  const [row] = await scoped(sql)<{ action: 'given' | 'revoked' }>`
    SELECT k.action FROM consents k JOIN clients cl ON cl.id = k.client_id
     WHERE k.client_id = ${clientId} AND k.kind = 'messenger_crossborder' AND ${scopeSql(viewer, 'client', 'client.read')}
     ORDER BY k.at DESC, k.created_at DESC, k.id DESC LIMIT 1`;
  return row?.action ?? null;
}

export type { Actor };
