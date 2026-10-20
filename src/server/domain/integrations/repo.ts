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
