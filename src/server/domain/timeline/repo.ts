// SQL ленты клиента. Чтение — только через scopeSql('client_event', 'card.read'); запись — внутри
// транзакции, где объект уже заблокирован с охватом (appendEvents без охвата, ARCHITECTURE §5.2).
import type { Viewer } from '@/server/access';
import { scopeSql, scoped } from '@/server/access/scope';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';

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
};

/** Страница ленты: события клиента и клиентов, слитых в него (цепочка до 8 звеньев, D-068). */
export async function readFeed(sql: Sql, viewer: Viewer, q: FeedQuery): Promise<FeedRow[]> {
  const curAt = q.cursor?.at ?? null;
  const curId = q.cursor?.id ?? null;
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
       AND NOT (ev.kind = 'field.changed' AND COALESCE(ev.data->>'sys', 'false') <> 'true'
                AND NOT (((ev.data->>'obj') || ':' || (ev.data->>'field')) = ANY(${q.visibleRefs}::text[])))
       AND (${curAt}::bigint IS NULL OR (ev.at, ev.id) < (${curAt}::bigint, ${curId}::text))
     ORDER BY ev.at DESC, ev.id DESC
     LIMIT ${q.limit + 1}`;
}
