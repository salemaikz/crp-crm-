// SQL ленты клиента. Чтение — только через scopeSql('client_event', 'card.read'); запись — внутри
// транзакции, где объект уже заблокирован с охватом (appendEvents без охвата, ARCHITECTURE §5.2).
import type { Viewer } from '@/server/access';
import { scopeSql, scoped } from '@/server/access/scope';
import { seesDealsOnlyAsDepartment } from '@/server/domain/deals/visibility';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import type { ClientSummaryDto, DealRowDto, NoteDto } from './types';

export type NewEvent = {
  clientId: string;
  kind: string;
  refType?: string;
  refId?: string;
  dealId?: string | null;
  data: Record<string, unknown>;
};

/** Записать события от имени сотрудника в его пространстве. Вызывается только внутри транзакции мутации. */
export async function appendEvents(sql: Sql, viewer: Viewer, events: readonly NewEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (viewer.spaceId === null) throw new Error('appendEvents: у сотрудника нет пространства');
  for (const e of events) {
    await sql`INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
              VALUES (${newId()}, ${e.clientId}, ${viewer.spaceId}, ${e.dealId ?? null}, ${e.kind}, ${viewer.userId}, ${viewer.now},
                      ${e.refType ?? ''}, ${e.refId ?? ''}, ${jsonParam(e.data)})`;
  }
}

export type FeedRow = {
  id: string;
  kind: string;
  at: number;
  actorId: string | null;
  actorName: string | null;
  refType: string;
  refId: string;
  dealId: string | null;
  data: unknown;
  /** Только для kind='message': текст сообщения (удалённое — null), состояние удаления и доставки (O7a). */
  text: string | null;
  deleted: boolean;
  deliveryStatus: string | null;
};

export type FeedQuery = {
  clientId: string;
  kinds: string[];
  /** `obj:ключ` видимых полей настроек: событие несистемного поля проходит только по этому списку. */
  visibleRefs: string[];
  cursor: { at: number; id: string } | null;
  limit: number;
  /** Только события этой сделки (`client_events_deal_idx`); сделку вызывающий уже проверил охватом. */
  dealId?: string | null;
};

/**
 * Страница ленты: события клиента и клиентов, слитых в него (цепочка до 8 звеньев, D-068). Отдел передачи (D-300)
 * видит события без сделки и события лишь тех сделок, чья передача ему видна; события других сделок клиента — нет.
 */
export async function readFeed(sql: Sql, viewer: Viewer, q: FeedQuery): Promise<FeedRow[]> {
  const curAt = q.cursor?.at ?? null;
  const curId = q.cursor?.id ?? null;
  const dealId = q.dealId ?? null;
  const departmentOnly = seesDealsOnlyAsDepartment(viewer);
  return scoped(sql)<FeedRow>`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT ${q.clientId}::text, 0
      UNION ALL
      SELECT m.id, chain.depth + 1 FROM clients m JOIN chain ON m.merged_into_id = chain.id WHERE chain.depth < 8
    )
    SELECT ev.id, ev.kind, ev.at, ev.actor_id, u.name AS actor_name, ev.ref_type, ev.ref_id, ev.deal_id, ev.data,
           mm.body AS text, COALESCE(mm.is_deleted, FALSE) AS deleted, mm.status AS delivery_status
      FROM client_events ev LEFT JOIN users u ON u.id = ev.actor_id
      LEFT JOIN messenger_messages mm ON ev.kind = 'message' AND ev.ref_type = 'messenger_message' AND mm.id = ev.ref_id
     WHERE ev.client_id IN (SELECT id FROM chain)
       AND ${scopeSql(viewer, 'client_event', 'card.read')}
       AND ev.kind = ANY(${q.kinds}::text[])
       AND (${dealId}::text IS NULL OR ev.deal_id = ${dealId}::text)
       AND (NOT ${departmentOnly}::boolean OR ev.deal_id IS NULL
            OR EXISTS (SELECT 1 FROM handoffs hd WHERE hd.deal_id = ev.deal_id AND ${scopeSql(viewer, 'handoff', 'handoff.read', { alias: 'hd' })}))
       AND NOT (ev.kind = 'field.changed' AND COALESCE(ev.data->>'sys', 'false') <> 'true'
                AND NOT (((ev.data->>'obj') || ':' || (ev.data->>'field')) = ANY(${q.visibleRefs}::text[])))
       AND (${curAt}::bigint IS NULL OR (ev.at, ev.id) < (${curAt}::bigint, ${curId}::text))
     ORDER BY ev.at DESC, ev.id DESC
     LIMIT ${q.limit + 1}`;
}

// ---------- Заметки (C8, §3.3) ----------

type NoteRowDb = { id: string; body: string; pinned: boolean; dealId: string | null; authorName: string | null; authorId: string | null; createdAt: number; clientId: string };

const toNote = (r: NoteRowDb): NoteDto => ({
  id: r.id,
  body: r.body,
  pinned: r.pinned,
  dealId: r.dealId,
  authorName: r.authorName,
  createdAt: r.createdAt,
});

/** Клиент виден с правом записи заметок (блокировка строки: заметки одного клиента пишутся по очереди — лимит закреплённых). */
export async function lockClientForNote(sql: Sql, viewer: Viewer, clientId: string): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    SELECT cl.id FROM clients cl
     WHERE cl.id = ${clientId} AND cl.merged_into_id IS NULL AND ${scopeSql(viewer, 'client', 'note.write')}
       FOR UPDATE OF cl`;
  return rows.length === 1;
}

/** Сделка того же клиента, видимая зрителю; отделу передачи (D-300) — только сделка видимой ему передачи. */
export async function dealOfClientVisible(sql: Sql, viewer: Viewer, clientId: string, dealId: string): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    SELECT d.id FROM deals d
     WHERE d.id = ${dealId} AND d.client_id = ${clientId} AND ${scopeSql(viewer, 'deal', 'deal.read')}
       AND (NOT ${seesDealsOnlyAsDepartment(viewer)}::boolean
            OR EXISTS (SELECT 1 FROM handoffs hd WHERE hd.deal_id = d.id AND ${scopeSql(viewer, 'handoff', 'handoff.read', { alias: 'hd' })}))`;
  return rows.length === 1;
}

/** Вставка заметки; повтор того же `id` не пишет ничего (`false`). */
export async function insertNote(
  sql: Sql,
  viewer: Viewer,
  n: { id: string; clientId: string; dealId: string | null; body: string },
): Promise<boolean> {
  if (viewer.spaceId === null) throw new Error('insertNote: у сотрудника нет пространства');
  const rows = await sql<{ id: string }>`
    INSERT INTO notes (id, client_id, space_id, deal_id, author_id, body, pinned, created_at)
    VALUES (${n.id}, ${n.clientId}, ${viewer.spaceId}, ${n.dealId}, ${viewer.userId}, ${n.body}, FALSE, ${viewer.now})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  return rows.length === 1;
}

/** Заметка по id с охватом чтения (повтор `opId` и ответ после записи). */
export async function selectNote(sql: Sql, viewer: Viewer, id: string): Promise<(NoteDto & { clientId: string; authorId: string | null }) | null> {
  const rows = await scoped(sql)<NoteRowDb>`
    SELECT n.id, n.client_id, n.author_id, n.body, n.pinned, n.deal_id, n.created_at, u.name AS author_name
      FROM notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.id = ${id} AND ${scopeSql(viewer, 'note', 'card.read')}`;
  const r = rows[0];
  return r ? { ...toNote(r), clientId: r.clientId, authorId: r.authorId } : null;
}

/** Сколько заметок клиента закреплено (под блокировкой клиента). */
export async function countPinned(sql: Sql, clientId: string, spaceId: string): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM notes WHERE client_id = ${clientId} AND space_id = ${spaceId} AND pinned`;
  return rows[0]?.n ?? 0;
}

/** Клиент заметки под охватом записи заметок; блокирует строку клиента (одна очередь на клиента). */
export async function lockNoteClient(sql: Sql, viewer: Viewer, noteId: string): Promise<string | null> {
  const rows = await scoped(sql)<{ clientId: string }>`
    SELECT cl.id AS client_id FROM clients cl JOIN notes n ON n.client_id = cl.id
     WHERE n.id = ${noteId} AND ${scopeSql(viewer, 'client', 'note.write')} AND ${scopeSql(viewer, 'note', 'note.write')}
       FOR UPDATE OF cl`;
  return rows[0]?.clientId ?? null;
}

/** Закрепить/открепить; `false` — заметки нет или нет права. */
export async function setNotePinned(sql: Sql, viewer: Viewer, id: string, pinned: boolean): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    UPDATE notes n SET pinned = ${pinned} WHERE n.id = ${id} AND ${scopeSql(viewer, 'note', 'note.write')} RETURNING n.id`;
  return rows.length === 1;
}

/** Закреплённые заметки клиента (до PIN_LIMIT), новые сверху. */
export async function selectPinnedNotes(sql: Sql, viewer: Viewer, clientId: string, limit: number): Promise<NoteDto[]> {
  if (viewer.spaceId === null) return [];
  const rows = await scoped(sql)<NoteRowDb>`
    SELECT n.id, n.client_id, n.body, n.pinned, n.deal_id, n.created_at, u.name AS author_name
      FROM notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.client_id = ${clientId} AND n.space_id = ${viewer.spaceId} AND n.pinned AND ${scopeSql(viewer, 'note', 'card.read')}
     ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit}`;
  return rows.map(toNote);
}

/** Тексты заметок страницы ленты одним запросом по id. */
export async function selectNotesByIds(sql: Sql, viewer: Viewer, ids: readonly string[]): Promise<NoteDto[]> {
  if (ids.length === 0) return [];
  const rows = await scoped(sql)<NoteRowDb>`
    SELECT n.id, n.client_id, n.body, n.pinned, n.deal_id, n.created_at, u.name AS author_name
      FROM notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.id = ANY(${ids as string[]}::text[]) AND ${scopeSql(viewer, 'note', 'card.read')}`;
  return rows.map(toNote);
}

// ---------- Итоговый отчёт (C8, §3.4): каждый запрос со своим охватом ----------

type SummaryParts = Pick<ClientSummaryDto, 'period' | 'lprFoundAt' | 'bookings' | 'purchases' | 'handoffs'> & {
  nextBookingAt: number | null;
  task: { source: string; dueAt: number | null } | null;
};

/**
 * `departmentOnly` (D-300): зритель видит сделки только по отношению передачи — покупки лишь тех сделок, чья передача
 * ему видна, и без сумм (как страница сделки, `findDealPageRow`).
 */
export async function selectSummaryParts(sql: Sql, viewer: Viewer, clientId: string, departmentOnly = false): Promise<SummaryParts> {
  if (viewer.spaceId === null) {
    return { period: null, lprFoundAt: null, bookings: [], purchases: [], handoffs: [], nextBookingAt: null, task: null };
  }
  const s = viewer.spaceId;
  const sc = scoped(sql);
  const calls = await sc<{ first: number | null; last: number | null; lprAt: number | null }>`
    SELECT min(ca.occurred_at) AS first, max(ca.occurred_at) AS last,
           min(ca.occurred_at) FILTER (WHERE ca.lpr = 'yes') AS lpr_at
      FROM calls ca WHERE ca.client_id = ${clientId} AND ca.space_id = ${s} AND ${scopeSql(viewer, 'call', 'card.read')}`;
  const bookings = await sc<{
    kind: 'group' | 'individual';
    eventTypeKey: string;
    bookingDate: string;
    startTime: string;
    status: ClientSummaryDto['bookings'][number]['status'];
    name: string | null;
  }>`
    SELECT b.kind, b.event_type_key, b.booking_date, b.start_time, b.status, u.name
      FROM bookings b LEFT JOIN resources r ON r.id = b.resource_id LEFT JOIN users u ON u.id = r.user_id
     WHERE b.client_id = ${clientId} AND b.space_id = ${s} AND b.status <> 'moved' AND ${scopeSql(viewer, 'booking', 'booking.read')}
     ORDER BY b.starts_at DESC LIMIT 10`;
  const nextB = await sc<{ at: number | null }>`
    SELECT min(b.starts_at) AS at FROM bookings b
     WHERE b.client_id = ${clientId} AND b.space_id = ${s} AND b.status IN ('registered','confirmed') AND b.starts_at > ${viewer.now}
       AND ${scopeSql(viewer, 'booking', 'booking.read')}`;
  const purchases = await sc<{ serviceTypeKey: string; amountKzt: number | null; wonAt: number }>`
    SELECT d.service_type_key, CASE WHEN ${departmentOnly}::boolean THEN NULL ELSE d.amount_kzt END AS amount_kzt, d.won_at FROM deals d
     WHERE d.client_id = ${clientId} AND d.space_id = ${s} AND d.status = 'won' AND ${scopeSql(viewer, 'deal', 'deal.read')}
       AND (NOT ${departmentOnly}::boolean
            OR EXISTS (SELECT 1 FROM handoffs hd WHERE hd.deal_id = d.id AND ${scopeSql(viewer, 'handoff', 'handoff.read', { alias: 'hd' })}))
     ORDER BY d.won_at`;
  const handoffs = await sc<{ key: string; status: string; createdAt: number; acceptedAt: number | null }>`
    SELECT t.key, h.status, h.created_at, h.accepted_at FROM handoffs h JOIN teams t ON t.id = h.team_id
     WHERE h.client_id = ${clientId} AND h.space_id_from = ${s} AND ${scopeSql(viewer, 'handoff', 'handoff.read')}
     ORDER BY h.created_at`;
  const task = await sc<{ source: string; dueAt: number | null }>`
    SELECT t.source, t.due_at FROM tasks t
     WHERE t.client_id = ${clientId} AND t.space_id = ${s} AND t.status = 'open' AND ${scopeSql(viewer, 'task', 'task.read')}
     ORDER BY t.due_at NULLS LAST LIMIT 1`;
  const c = calls[0];
  return {
    period: c && c.first !== null && c.last !== null ? { from: c.first, to: c.last } : null,
    lprFoundAt: c?.lprAt ?? null,
    bookings: bookings.map((b) => ({
      kind: b.kind,
      eventTypeKey: b.eventTypeKey,
      date: b.bookingDate,
      time: b.startTime,
      status: b.status,
      consultantName: b.name,
    })),
    purchases,
    handoffs: handoffs.map((h) => ({ teamKey: h.key, status: h.status, createdAt: h.createdAt, acceptedAt: h.acceptedAt })),
    nextBookingAt: nextB[0]?.at ?? null,
    task: task[0] ?? null,
  };
}

// ---------- История сделок (C8, §3.5) ----------

/** `departmentOnly` (D-300): только сделки передачи и без сумм. */
export async function selectDeals(sql: Sql, viewer: Viewer, clientId: string, departmentOnly = false): Promise<DealRowDto[]> {
  if (viewer.spaceId === null) return [];
  const rows = await scoped(sql)<{
    id: string;
    pipelineKey: string;
    stageKey: string;
    status: 'open' | 'won' | 'lost';
    serviceTypeKey: string;
    amountKzt: number | null;
    createdAt: number;
    wonAt: number | null;
    lostAt: number | null;
    lostReasonCode: string;
    ownerName: string | null;
  }>`
    SELECT d.id, d.pipeline_key, d.stage_key, d.status, d.service_type_key,
           CASE WHEN ${departmentOnly}::boolean THEN NULL ELSE d.amount_kzt END AS amount_kzt, d.created_at, d.won_at, d.lost_at,
           d.lost_reason_code, u.name AS owner_name
      FROM deals d LEFT JOIN users u ON u.id = d.owner_user_id
     WHERE d.client_id = ${clientId} AND d.space_id = ${viewer.spaceId} AND ${scopeSql(viewer, 'deal', 'deal.read')}
       AND (NOT ${departmentOnly}::boolean
            OR EXISTS (SELECT 1 FROM handoffs hd WHERE hd.deal_id = d.id AND ${scopeSql(viewer, 'handoff', 'handoff.read', { alias: 'hd' })}))
     ORDER BY d.created_at DESC, d.id DESC LIMIT 50`;
  return rows;
}
