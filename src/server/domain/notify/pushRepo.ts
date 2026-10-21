// Весь SQL web-push (P8b, D-328). Подписка — личная: каждое изменение строки пользователя фильтруется по `user_id`
// из Viewer. Push уходит, только пока жива сессия, которая подписала устройство: «живая» = строка sessions с тем же
// сотрудником, срок не истёк, сотрудник активен и с паролем (простой idleHours не учитывается — текст без ПДн, а открыть
// уведомление всё равно можно только после входа). Служебные чтения очереди (воркер) возвращают только id, коды и числа.
import { newId, type Sql } from '@/server/platform/db';

// ---------------------------------------------------------------------------
// Переключатель и отметка решения клиента
// ---------------------------------------------------------------------------

export interface PushSettingsRow {
  enabled: boolean;
  crossborderApprovedAt: number | null;
  updatedAt: number | null;
}

export async function readPushSettings(sql: Sql): Promise<PushSettingsRow> {
  const [row] = await sql<PushSettingsRow>`SELECT enabled, crossborder_approved_at, updated_at FROM push_settings WHERE id = 1`;
  return row ?? { enabled: false, crossborderApprovedAt: null, updatedAt: null };
}

export async function savePushSettings(sql: Sql, a: { enabled: boolean; approvedAt: number | null; approvedBy: string | null; keepApproval: boolean; by: string; now: number }): Promise<void> {
  // keepApproval — отметку не трогаем (меняется только переключатель)
  await sql`
    INSERT INTO push_settings (id, enabled, crossborder_approved_at, crossborder_approved_by, updated_at, updated_by)
    VALUES (1, ${a.enabled}, ${a.approvedAt}::bigint, ${a.approvedBy}, ${a.now}::bigint, ${a.by})
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      crossborder_approved_at = CASE WHEN ${a.keepApproval} THEN push_settings.crossborder_approved_at ELSE EXCLUDED.crossborder_approved_at END,
      crossborder_approved_by = CASE WHEN ${a.keepApproval} THEN push_settings.crossborder_approved_by ELSE EXCLUDED.crossborder_approved_by END,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by`;
}

// ---------------------------------------------------------------------------
// Подписки устройства
// ---------------------------------------------------------------------------

export interface NewSubscription {
  userId: string;
  sessionId: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  now: number;
}

/**
 * Upsert по адресу: устройство одно, сотрудники на нём меняются (общий телефон). Владелец, ключи и сессия
 * перезаписываются, выключение снимается. Сменился владелец — его стоящие строки очереди отменяются, а время
 * подписки — новое (старые уведомления прежнего сотрудника в неё не попадут). Вызывать в транзакции.
 */
export async function upsertSubscription(sql: Sql, a: NewSubscription): Promise<{ id: string; ownerChanged: boolean }> {
  const [prev] = await sql<{ id: string; userId: string }>`SELECT id, user_id FROM push_subscriptions WHERE endpoint = ${a.endpoint} FOR UPDATE`;
  const [row] = await sql<{ id: string }>`
    INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth, created_at, session_id)
    VALUES (${newId()}, ${a.userId}, ${a.deviceId}, ${a.endpoint}, ${a.p256dh}, ${a.auth}, ${a.now}::bigint, ${a.sessionId})
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = EXCLUDED.user_id, device_id = EXCLUDED.device_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
      session_id = EXCLUDED.session_id, disabled_at = NULL,
      created_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.created_at ELSE EXCLUDED.created_at END
    RETURNING id`;
  const id = row!.id;
  const ownerChanged = prev !== undefined && prev.userId !== a.userId;
  if (ownerChanged) await cancelPending(sql, [id], 'owner_changed');
  return { id, ownerChanged };
}

/** Сверх `keep` действующих подписок сотрудника — старейшие выключаются. Возвращает число выключенных. */
export async function trimSubscriptions(sql: Sql, a: { userId: string; keep: number; now: number }): Promise<number> {
  const rows = await sql<{ id: string }>`
    UPDATE push_subscriptions SET disabled_at = ${a.now}::bigint
     WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = ${a.userId} AND disabled_at IS NULL
                   ORDER BY created_at DESC, id OFFSET ${a.keep})
    RETURNING id`;
  await cancelPending(sql, rows.map((r) => r.id), 'trimmed');
  return rows.length;
}

/** Выключить свои подписки: этой сессии и (если задан) с этим адресом. Чужие строки не трогаются. */
export async function disableOwnSubscriptions(sql: Sql, a: { userId: string; sessionId: string | null; endpoint: string | null; now: number }): Promise<number> {
  const rows = await sql<{ id: string }>`
    UPDATE push_subscriptions SET disabled_at = ${a.now}::bigint
     WHERE user_id = ${a.userId} AND disabled_at IS NULL
       AND ((${a.sessionId}::text IS NOT NULL AND session_id = ${a.sessionId}::text)
            OR (${a.endpoint}::text IS NOT NULL AND endpoint = ${a.endpoint}::text))
    RETURNING id`;
  await cancelPending(sql, rows.map((r) => r.id), 'unsubscribed');
  return rows.length;
}

async function cancelPending(sql: Sql, subscriptionIds: readonly string[], code: string): Promise<void> {
  if (subscriptionIds.length === 0) return;
  await sql`
    UPDATE push_outbox SET state = 'cancelled', lease_until = NULL, error = ${code}
     WHERE subscription_id = ANY(${[...subscriptionIds]}::text[]) AND state = 'pending'`;
}

// ---------------------------------------------------------------------------
// Очередь (воркер)
// ---------------------------------------------------------------------------

/** Подписки, чья сессия умерла (выход, «выйти везде», отключение, срок): выключаются, их очередь отменяется. */
export async function disableDeadSubscriptions(sql: Sql, now: number): Promise<number> {
  const rows = await sql<{ id: string }>`
    UPDATE push_subscriptions s SET disabled_at = ${now}::bigint
     WHERE s.disabled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sessions se JOIN users u ON u.id = se.user_id
                        WHERE se.id = s.session_id AND se.user_id = s.user_id AND se.expires_at > ${now}::bigint
                          AND u.status = 'active' AND u.password_hash IS NOT NULL)
    RETURNING s.id`;
  await cancelPending(sql, rows.map((r) => r.id), 'session_gone');
  return rows.length;
}

export interface PushCandidate {
  notificationId: string;
  subscriptionId: string;
  kind: string;
  params: Record<string, unknown>;
}

/**
 * Пары «уведомление × подписка» без строки очереди: вид из списка, не прочитано, не старше `since` и не старше
 * подписки, получатель = владелец подписки, сессия подписки жива.
 */
export async function pushCandidates(sql: Sql, a: { kinds: readonly string[]; since: number; now: number; limit: number }): Promise<PushCandidate[]> {
  return sql<PushCandidate>`
    SELECT n.id AS notification_id, s.id AS subscription_id, n.kind, n.params
      FROM notifications n
      JOIN push_subscriptions s ON s.user_id = n.user_id AND s.disabled_at IS NULL
     WHERE n.kind = ANY(${[...a.kinds]}::text[])
       AND n.read_at IS NULL
       AND n.created_at >= ${a.since}::bigint
       AND n.created_at >= s.created_at
       AND EXISTS (SELECT 1 FROM sessions se JOIN users u ON u.id = se.user_id
                    WHERE se.id = s.session_id AND se.user_id = s.user_id AND se.expires_at > ${a.now}::bigint
                      AND u.status = 'active' AND u.password_hash IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM push_outbox o WHERE o.notification_id = n.id AND o.subscription_id = s.id)
     ORDER BY n.created_at, n.id
     LIMIT ${a.limit}`;
}

/** Записать строки очереди; повтор пары ничего не меняет (UNIQUE). Возвращает число новых. */
export async function insertOutbox(
  sql: Sql,
  a: { rows: ReadonlyArray<{ notificationId: string; subscriptionId: string; payload: string; nextAt: number }>; now: number },
): Promise<number> {
  if (a.rows.length === 0) return 0;
  const inserted = await sql<{ id: string }>`
    INSERT INTO push_outbox (id, notification_id, subscription_id, payload, state, next_at, created_at)
    SELECT x.id, x.nid, x.sid, x.payload::jsonb, 'pending', x.next_at, ${a.now}::bigint
      FROM unnest(${a.rows.map(() => newId())}::text[], ${a.rows.map((r) => r.notificationId)}::text[],
                  ${a.rows.map((r) => r.subscriptionId)}::text[], ${a.rows.map((r) => r.payload)}::text[],
                  ${a.rows.map((r) => r.nextAt)}::bigint[]) AS x(id, nid, sid, payload, next_at)
    ON CONFLICT (notification_id, subscription_id) DO NOTHING
    RETURNING id`;
  return inserted.length;
}

/** Строка очереди со всем, что нужно сверить перед отправкой. Адрес и ключи — только для запроса, не для журнала. */
export interface OutboxItemRow {
  state: string;
  payload: Record<string, unknown>;
  nextAt: number;
  readAt: number | null;
  sameOwner: boolean;
  subscriptionId: string;
  disabledAt: number | null;
  sessionAlive: boolean;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function loadOutboxItem(sql: Sql, a: { id: string; now: number }): Promise<OutboxItemRow | null> {
  const [row] = await sql<OutboxItemRow>`
    SELECT o.state, o.payload, o.next_at, n.read_at, (n.user_id = s.user_id) AS same_owner,
           s.id AS subscription_id, s.disabled_at, s.endpoint, s.p256dh, s.auth,
           EXISTS (SELECT 1 FROM sessions se JOIN users u ON u.id = se.user_id
                    WHERE se.id = s.session_id AND se.user_id = s.user_id AND se.expires_at > ${a.now}::bigint
                      AND u.status = 'active' AND u.password_hash IS NOT NULL) AS session_alive
      FROM push_outbox o
      JOIN notifications n ON n.id = o.notification_id
      JOIN push_subscriptions s ON s.id = o.subscription_id
     WHERE o.id = ${a.id}`;
  return row ?? null;
}

/** Push-сервис ответил 404/410: подписки нет — выключить и отменить её очередь. */
export async function markSubscriptionGone(sql: Sql, a: { subscriptionId: string; now: number }): Promise<void> {
  await sql`UPDATE push_subscriptions SET disabled_at = ${a.now}::bigint WHERE id = ${a.subscriptionId} AND disabled_at IS NULL`;
  await cancelPending(sql, [a.subscriptionId], 'gone');
}

export async function markSubscriptionOk(sql: Sql, a: { subscriptionId: string; now: number }): Promise<void> {
  await sql`UPDATE push_subscriptions SET last_ok_at = ${a.now}::bigint WHERE id = ${a.subscriptionId}`;
}

/** Чистка: выключенные раньше `before` подписки без строк очереди. */
export async function purgeDisabledSubscriptions(sql: Sql, before: number): Promise<number> {
  const rows = await sql<{ id: string }>`
    DELETE FROM push_subscriptions s
     WHERE s.disabled_at IS NOT NULL AND s.disabled_at < ${before}::bigint
       AND NOT EXISTS (SELECT 1 FROM push_outbox o WHERE o.subscription_id = s.id)
    RETURNING s.id`;
  return rows.length;
}
