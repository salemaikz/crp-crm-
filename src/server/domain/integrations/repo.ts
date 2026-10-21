// SQL интеграций: подключения, приём вебхуков (webhook_inbox), чистка payload. Подключения — настройки установки,
// а не данные клиентов, поэтому охвата scopeSql здесь нет: доступ решают маршрут (администратор) и токен вебхука.
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import type { InboxItem } from '@/integrations/contract';
import type { InboxRow, IntegrationRow } from './types';

/** Подключение по хэшу токена вебхука и плагину (индекс UNIQUE webhook_token_hash). */
export async function findHookTarget(sql: Sql, pluginId: string, tokenHash: string): Promise<IntegrationRow | null> {
  const [row] = await sql<IntegrationRow>`
    SELECT id, plugin_id, space_id, config, enabled, status, last_event_at, crossborder_approved_at
      FROM integrations WHERE webhook_token_hash = ${tokenHash} AND plugin_id = ${pluginId}`;
  return row ?? null;
}

/** Подключения, действующие в пространстве: свои и общие на всю установку (space_id IS NULL). */
export async function listSpaceIntegrations(sql: Sql, spaceId: string): Promise<IntegrationRow[]> {
  return sql<IntegrationRow>`
    SELECT id, plugin_id, space_id, config, enabled, status, last_event_at, crossborder_approved_at
      FROM integrations WHERE space_id = ${spaceId} OR space_id IS NULL
     ORDER BY created_at, id`;
}

/** Есть ли у подключения включённый канал в пространстве (режим окна чата). */
export async function hasEnabledChannel(sql: Sql, integrationId: string, spaceId: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM messenger_channels
                    WHERE integration_id = ${integrationId} AND space_id = ${spaceId} AND is_enabled) AS ok`;
  return row?.ok === true;
}

/**
 * Строки inbox одним INSERT; повтор ключа (integration_id, dedupe_key) — ничего не делает (повторная доставка
 * не задваивает). Возвращает число новых строк.
 */
export async function insertInboxItems(sql: Sql, integrationId: string, items: readonly InboxItem[], now: number): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map((i) => ({ id: newId(), dedupe_key: i.dedupeKey, kind: i.kind, payload: i.payload ?? null }));
  const inserted = await sql<{ id: string }>`
    INSERT INTO webhook_inbox (id, integration_id, dedupe_key, kind, payload, state, attempts, next_at, received_at)
    SELECT x.id, ${integrationId}, x.dedupe_key, x.kind, NULLIF(x.payload, 'null'::jsonb), 'pending', 0, ${now}, ${now}
      FROM jsonb_to_recordset(${jsonParam(rows)}) AS x(id text, dedupe_key text, kind text, payload jsonb)
    ON CONFLICT (integration_id, dedupe_key) DO NOTHING
    RETURNING id`;
  return inserted.length;
}

/** «События идут»: last_event_at не чаще раза в минуту на подключение (без лишних UPDATE на каждый вебхук). */
export async function touchLastEvent(sql: Sql, integrationId: string, now: number, stepMs: number): Promise<void> {
  await sql`
    UPDATE integrations SET last_event_at = ${now}
     WHERE id = ${integrationId} AND (last_event_at IS NULL OR last_event_at < ${now - stepMs})`;
}

export async function loadInboxRow(sql: Sql, id: string): Promise<InboxRow | null> {
  const [row] = await sql<InboxRow>`
    SELECT w.id, w.integration_id, i.plugin_id, w.kind, w.payload
      FROM webhook_inbox w JOIN integrations i ON i.id = w.integration_id
     WHERE w.id = ${id}`;
  return row ?? null;
}

/** Чистка ПДн: payload старше срока обнуляется (индекс webhook_inbox_purge_idx); строки остаются. */
export async function clearInboxPayloads(sql: Sql, before: number): Promise<number> {
  const rows = await sql<{ id: string }>`
    UPDATE webhook_inbox SET payload = NULL WHERE payload IS NOT NULL AND received_at < ${before} RETURNING id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Администрирование подключений (дизайн §7.5)
// ---------------------------------------------------------------------------


export async function getIntegrationRow(sql: Sql, id: string): Promise<IntegrationRow | null> {
  const [row] = await sql<IntegrationRow>`
    SELECT id, plugin_id, space_id, config, enabled, status, last_event_at, crossborder_approved_at FROM integrations WHERE id = ${id}`;
  return row ?? null;
}

/** Подключения плагина (обычно одно). */
export async function listIntegrationsOf(sql: Sql, pluginId: string): Promise<IntegrationRow[]> {
  return sql<IntegrationRow>`
    SELECT id, plugin_id, space_id, config, enabled, status, last_event_at, crossborder_approved_at
      FROM integrations WHERE plugin_id = ${pluginId} ORDER BY created_at, id`;
}

export async function defaultSpaceId(sql: Sql): Promise<string | null> {
  const [row] = await sql<{ id: string }>`SELECT id FROM spaces WHERE is_default ORDER BY created_at LIMIT 1`;
  return row?.id ?? null;
}

/**
 * Подключение плагина создаётся или меняется только под этой блокировкой (до конца транзакции): два параллельных
 * «Подключить» не создают двух строк. Уникального индекса нет намеренно: схема v1 не правится, а будущие подключения
 * по пространствам допускают несколько строк на плагин (D-298).
 */
export async function lockPluginConnections(tx: Sql, pluginId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`integration-connect:${pluginId}`}, 0))`;
}

export async function insertIntegration(sql: Sql, a: { id: string; pluginId: string; spaceId: string | null; now: number }): Promise<void> {
  await sql`
    INSERT INTO integrations (id, plugin_id, space_id, config, enabled, status, created_at, updated_at)
    VALUES (${a.id}, ${a.pluginId}, ${a.spaceId}, '{}'::jsonb, FALSE, 'unknown', ${a.now}, ${a.now})`;
}

/**
 * Новый ключ того же подключения: выключаем, сбрасываем адрес вебхука и выключаем каналы — ключ мог быть от другого
 * аккаунта, каналы старого не должны принимать сообщения (после смены ключа всё включается заново, D-298).
 */
export async function resetIntegration(sql: Sql, id: string, now: number): Promise<void> {
  await sql`UPDATE integrations SET enabled = FALSE, status = 'unknown', webhook_token_hash = NULL, updated_at = ${now} WHERE id = ${id}`;
  await sql`UPDATE messenger_channels SET is_enabled = FALSE, updated_at = ${now} WHERE integration_id = ${id} AND is_enabled`;
}

export async function setStatus(sql: Sql, id: string, status: string, now: number): Promise<void> {
  await sql`UPDATE integrations SET status = ${status}, updated_at = ${now} WHERE id = ${id}`;
}

export async function setWebhookToken(sql: Sql, id: string, hash: string | null, now: number): Promise<void> {
  await sql`UPDATE integrations SET webhook_token_hash = ${hash}, updated_at = ${now} WHERE id = ${id}`;
}

/**
 * Выключить и отозвать адрес вебхука одной строкой (мутации безопасности D-054: «Выключить», отзыв адреса без
 * переподписки). Сброс токена заодно срывает идущее «Включить»: его последний шаг требует своего токена (D-298).
 */
export async function switchOff(sql: Sql, id: string, now: number): Promise<void> {
  await sql`UPDATE integrations SET enabled = FALSE, webhook_token_hash = NULL, updated_at = ${now} WHERE id = ${id}`;
}

/**
 * Последний шаг «Включить»: только если адрес вебхука всё ещё тот, что выдало это включение. «Выключить», снятие
 * отметки о решении или новый ключ за время подписки его сбросили — включение не состоится (false).
 */
export async function enableIfToken(sql: Sql, a: { id: string; tokenHash: string; now: number }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE integrations SET enabled = TRUE, updated_at = ${a.now}
     WHERE id = ${a.id} AND NOT enabled AND webhook_token_hash = ${a.tokenHash} RETURNING id`;
  return rows.length > 0;
}

/** Сбросить адрес вебхука, только если это всё ещё наш токен (неудачное включение не затирает чужое). */
export async function clearWebhookTokenIf(sql: Sql, a: { id: string; tokenHash: string; now: number }): Promise<void> {
  await sql`UPDATE integrations SET webhook_token_hash = NULL, updated_at = ${a.now} WHERE id = ${a.id} AND webhook_token_hash = ${a.tokenHash}`;
}

/** Отметка решения о передаче ПДн за рубеж; снятие отметки сразу выключает подключение и отзывает адрес вебхука. */
export async function setCrossborder(sql: Sql, a: { id: string; approvedAt: number | null; by: string | null; now: number }): Promise<void> {
  await sql`
    UPDATE integrations SET crossborder_approved_at = ${a.approvedAt}, crossborder_approved_by = ${a.by},
           enabled = CASE WHEN ${a.approvedAt}::bigint IS NULL THEN FALSE ELSE enabled END,
           webhook_token_hash = CASE WHEN ${a.approvedAt}::bigint IS NULL THEN NULL ELSE webhook_token_hash END,
           updated_at = ${a.now}
     WHERE id = ${a.id}`;
}

/** Активные администраторы установки: получатели уведомлений о подключениях. */
export async function activeAdminIds(sql: Sql): Promise<string[]> {
  return (await sql<{ id: string }>`SELECT id FROM users WHERE is_admin AND status = 'active' ORDER BY id`).map((r) => r.id);
}

/** Строки inbox подключения, ушедшие в failed с момента `since` (число для уведомления администратору). */
export async function countFailedInbox(sql: Sql, a: { integrationId: string; since: number }): Promise<number> {
  const [r] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM webhook_inbox WHERE integration_id = ${a.integrationId} AND state = 'failed' AND received_at >= ${a.since}`;
  return r?.n ?? 0;
}

/** Уведомление сотруднику по ключу идемпотентности: повтор ничего не меняет. params — только коды и числа. */
export async function insertAdminNotice(
  sql: Sql,
  a: { userId: string; kind: string; entityType: string; entityId: string; params: Record<string, number | string>; dedupeKey: string; now: number },
): Promise<void> {
  await sql`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${a.userId}, ${a.kind}, ${a.entityType}, ${a.entityId}, ${jsonParam(a.params)}, ${a.dedupeKey}, ${a.now}, ${a.now})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

/** Активные сотрудники пространства: id и имя (для выгрузки пользователей провайдеру). */
export async function activeStaff(sql: Sql, a: { spaceId: string; onlyUserId?: string }): Promise<{ id: string; name: string }[]> {
  return sql<{ id: string; name: string }>`
    SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND (${a.onlyUserId ?? null}::text IS NULL OR u.id = ${a.onlyUserId ?? null}::text)
     ORDER BY u.name, u.id`;
}

export async function isActiveMember(sql: Sql, a: { spaceId: string; userId: string }): Promise<boolean> {
  const rows = await sql<{ userId: string }>`
    SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.user_id = ${a.userId} AND m.status = 'active'`;
  return rows.length > 0;
}

export interface ChannelView {
  id: string;
  integrationId: string;
  spaceId: string;
  providerChannelId: string;
  transport: string;
  plainId: string | null;
  state: string;
  stateChangedAt: number | null;
  ownerUserId: string | null;
  isEnabled: boolean;
}

export async function channelsOf(sql: Sql, integrationId: string): Promise<ChannelView[]> {
  return sql<ChannelView>`
    SELECT id, integration_id, space_id, provider_channel_id, transport, plain_id, state, state_changed_at, owner_user_id, is_enabled
      FROM messenger_channels WHERE integration_id = ${integrationId} ORDER BY transport, provider_channel_id`;
}

export async function patchChannelRow(sql: Sql, a: { integrationId: string; channelId: string; ownerUserId: string | null | undefined; isEnabled: boolean | undefined; now: number }): Promise<ChannelView | null> {
  const setOwner = a.ownerUserId !== undefined;
  const [row] = await sql<ChannelView>`
    UPDATE messenger_channels SET
      owner_user_id = CASE WHEN ${setOwner} THEN ${a.ownerUserId ?? null}::text ELSE owner_user_id END,
      is_enabled = COALESCE(${a.isEnabled ?? null}::boolean, is_enabled), updated_at = ${a.now}
     WHERE id = ${a.channelId} AND integration_id = ${a.integrationId}
     RETURNING id, integration_id, space_id, provider_channel_id, transport, plain_id, state, state_changed_at, owner_user_id, is_enabled`;
  return row ?? null;
}
