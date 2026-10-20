// Весь SQL уведомлений. Колокол личный: каждое чтение и изменение строк пользователя фильтруется по `user_id`,
// который сервис берёт из Viewer (а не из запроса) — чужое не прочитать и не отметить. Сводки и тревоги читают
// агрегаты по пространству (служебные чтения: наружу идут только числа и id получателей, без охвата).
import type { Sql } from '@/server/platform/db';
import type { NotificationView } from './types';

// ---------------------------------------------------------------------------
// Колокол пользователя
// ---------------------------------------------------------------------------

export async function listForUser(sql: Sql, a: { userId: string; before: number | null; limit: number }): Promise<NotificationView[]> {
  return sql<NotificationView>`
    SELECT id, kind, params, created_at, read_at
      FROM notifications
     WHERE user_id = ${a.userId} AND (${a.before}::bigint IS NULL OR created_at < ${a.before}::bigint)
     ORDER BY created_at DESC, id DESC
     LIMIT ${a.limit}`;
}

export async function countUnread(sql: Sql, userId: string): Promise<number> {
  const [row] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId} AND read_at IS NULL`;
  return row?.n ?? 0;
}

/** Отметить прочитанными свои уведомления (`ids` = null — все непрочитанные). Возвращает сколько отмечено. */
export async function markRead(sql: Sql, a: { userId: string; ids: readonly string[] | null; now: number }): Promise<number> {
  const rows =
    a.ids === null
      ? await sql<{ id: string }>`
          UPDATE notifications SET read_at = ${a.now} WHERE user_id = ${a.userId} AND read_at IS NULL RETURNING id`
      : await sql<{ id: string }>`
          UPDATE notifications SET read_at = ${a.now}
           WHERE user_id = ${a.userId} AND id = ANY(${[...a.ids]}::text[]) AND read_at IS NULL RETURNING id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Запись (сводка, тревоги)
// ---------------------------------------------------------------------------

export interface NewNotification {
  id: string;
  userId: string;
  kind: string;
  params: Record<string, number | string>;
  dedupeKey: string;
}

/**
 * Записать пачку. `ignore` — повтор слота ничего не меняет (сводка); `refresh` — пока уведомление не прочитано,
 * обновляются числа и время (тревога «всё ещё N»), прочитанное не воскрешается. Возвращает число записанных строк.
 * Тихие часы (`not_before`) касаются только push: колокол показывает сразу, поэтому `not_before = now`.
 */
export async function insertNotifications(
  sql: Sql,
  a: { rows: readonly NewNotification[]; mode: 'ignore' | 'refresh'; now: number },
): Promise<number> {
  if (a.rows.length === 0) return 0;
  const ids = a.rows.map((r) => r.id);
  const users = a.rows.map((r) => r.userId);
  const kinds = a.rows.map((r) => r.kind);
  const params = a.rows.map((r) => JSON.stringify(r.params));
  const keys = a.rows.map((r) => r.dedupeKey);
  const out =
    a.mode === 'ignore'
      ? await sql<{ id: string }>`
          INSERT INTO notifications (id, user_id, kind, params, dedupe_key, not_before, created_at)
          SELECT t.id, t.user_id, t.kind, t.params::jsonb, t.dedupe_key, ${a.now}::bigint, ${a.now}::bigint
            FROM unnest(${ids}::text[], ${users}::text[], ${kinds}::text[], ${params}::text[], ${keys}::text[])
                 AS t(id, user_id, kind, params, dedupe_key)
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id`
      : await sql<{ id: string }>`
          INSERT INTO notifications (id, user_id, kind, params, dedupe_key, not_before, created_at)
          SELECT t.id, t.user_id, t.kind, t.params::jsonb, t.dedupe_key, ${a.now}::bigint, ${a.now}::bigint
            FROM unnest(${ids}::text[], ${users}::text[], ${kinds}::text[], ${params}::text[], ${keys}::text[])
                 AS t(id, user_id, kind, params, dedupe_key)
          ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
          DO UPDATE SET params = EXCLUDED.params, created_at = EXCLUDED.created_at
                  WHERE notifications.read_at IS NULL AND notifications.params IS DISTINCT FROM EXCLUDED.params
          RETURNING id`;
  return out.length;
}

// ---------------------------------------------------------------------------
// Получатели и числа для сводок и тревог
// ---------------------------------------------------------------------------

/** Активные сотрудники пространства с одной из ролей. */
export async function listRecipients(sql: Sql, a: { spaceId: string; roles: readonly string[] }): Promise<string[]> {
  if (a.roles.length === 0) return [];
  const rows = await sql<{ userId: string }>`
    SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND m.role_key = ANY(${[...a.roles]}::text[])
     ORDER BY m.user_id`;
  return rows.map((r) => r.userId);
}

/** Перезвоны со сроком до `before` (включая просроченные) по текущим владельцам (временный владелец — владелец). */
export async function countCallbacksDue(sql: Sql, a: { spaceId: string; userIds: readonly string[]; before: number }): Promise<Map<string, number>> {
  const rows = await sql<{ userId: string; n: number }>`
    SELECT COALESCE(c.acting_user_id, c.owner_user_id) AS user_id, count(*)::int AS n
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.state = 'callback' AND c.hold_reason = '' AND c.next_call_at < ${a.before}::bigint
       AND COALESCE(c.acting_user_id, c.owner_user_id) = ANY(${[...a.userIds]}::text[])
     GROUP BY 1`;
  return new Map(rows.map((r) => [r.userId, r.n]));
}

/** Живые записи, где сотрудник ответственный, на местный день. */
export async function countBookingsOnDay(sql: Sql, a: { spaceId: string; userIds: readonly string[]; day: string }): Promise<Map<string, number>> {
  const rows = await sql<{ userId: string; n: number }>`
    SELECT b.responsible_user_id AS user_id, count(*)::int AS n
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booking_date = ${a.day}::text AND b.status IN ('registered','confirmed')
       AND b.responsible_user_id = ANY(${[...a.userIds]}::text[])
     GROUP BY 1`;
  return new Map(rows.map((r) => [r.userId, r.n]));
}

/** Просроченные перезвоны по карточкам (D-050): срок раньше `olderThan`. Сколько карточек и у скольких владельцев. */
export async function overdueCallbackStats(sql: Sql, a: { spaceId: string; olderThan: number }): Promise<{ count: number; operators: number }> {
  const [row] = await sql<{ count: number; operators: number }>`
    SELECT count(*)::int AS count, count(DISTINCT COALESCE(c.acting_user_id, c.owner_user_id))::int AS operators
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.state = 'callback' AND c.hold_reason = ''
       AND c.next_call_at <= ${a.olderThan}::bigint AND COALESCE(c.acting_user_id, c.owner_user_id) IS NOT NULL`;
  return { count: row?.count ?? 0, operators: row?.operators ?? 0 };
}

/** Готовые к раздаче карточки пула (без владельца, `new`, без задержки). */
export async function countPool(sql: Sql, spaceId: string): Promise<number> {
  const [row] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM cards WHERE space_id = ${spaceId} AND owner_user_id IS NULL AND state = 'new' AND hold_reason = ''`;
  return row?.n ?? 0;
}

/** Передачи из пространства, которые отдел не принял к сроку (`due_at` — конец рабочего дня, ставит B6). */
export async function countUnacceptedHandoffs(sql: Sql, a: { spaceId: string; now: number }): Promise<number> {
  const [row] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM handoffs
     WHERE space_id_from = ${a.spaceId} AND status = 'pending' AND due_at <= ${a.now}::bigint`;
  return row?.n ?? 0;
}

/** «Серые» консультации, которым до начала ещё не нашли консультанта и которые ждут дольше `createdBefore`. */
export async function countGreyUnassigned(sql: Sql, a: { spaceId: string; now: number; createdBefore: number }): Promise<number> {
  const [row] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings
     WHERE space_id = ${a.spaceId} AND kind = 'individual' AND resource_id IS NULL AND status IN ('registered','confirmed')
       AND starts_at > ${a.now}::bigint AND created_at <= ${a.createdBefore}::bigint`;
  return row?.n ?? 0;
}
