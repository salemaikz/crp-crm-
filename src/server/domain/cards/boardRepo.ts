// SQL доски оператора (docs/pipeline-v2-design.md §2.3, §6.2). Два шага: страница ключей колонки (id и ключ порядка,
// ключевая пагинация без OFFSET) и дозагрузка строк по id. Охват `scopeSql(viewer, 'card', 'card.read')` стоит в каждом
// SELECT обоих шагов: чужая карточка не попадает ни в колонку, ни в «Ещё», ни в поиск.
import type { calling } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

/** Больше любого срока и любой даты: ключ порядка для NULL («без срока в конце»). Меньше 2^53, чтобы пройти через JS. */
export const KEY_MAX = 9_000_000_000_000_000;

/** Чем отличаются колонки по порядку и условию (§2.1). */
export type ColumnKind = 'new' | 'callback' | 'agreed' | 'client' | 'closed';

export interface BoardFilters {
  /** Только при охвате не `own`: проверяет `board.ts`. */
  owner: string | null;
  today: boolean;
  attendedGroup: boolean;
  attendedIndividual: boolean;
  noShow: boolean;
  purchased: boolean;
  callbackReason: string | null;
}

/** Ключ страницы: часть («огонёк» или остальные) и три числа порядка. Для колонки «Перезвон» k1 = heat, k2 = срок. */
export interface KeyCursor {
  part: 0 | 1;
  k1: number;
  k2: number;
  k3: number;
  id: string;
}

export interface ColumnSelect {
  spaceId: string;
  kind: ColumnKind;
  states: readonly string[];
  /** Только `agreed`: виды записи колонки, виды всех колонок `agreed` и признак колонки по умолчанию. */
  agreed: { types: readonly string[]; allTypes: readonly string[]; fallback: boolean };
  /** Только `closed`: нижняя граница `closed_at` (окно `recentDays`); null — без окна. */
  closedFrom: number | null;
  bounds: calling.DueBounds;
  cursor: KeyCursor | null;
  /** Сколько ключей вернуть (вызывающий просит limit + 1, чтобы узнать, есть ли «Ещё»). */
  limit: number;
  filters: BoardFilters;
}

export interface KeyRow {
  id: string;
  part: 0 | 1;
  k1: number;
  k2: number;
  k3: number;
}

const cur = (c: KeyCursor | null) => ({
  on: c !== null,
  part: c?.part ?? 0,
  k1: c?.k1 ?? 0,
  k2: c?.k2 ?? 0,
  k3: c?.k3 ?? 0,
  id: c?.id ?? '',
});

/** Страница ключей колонки «Перезвон»: огонёк (срок раньше начала завтрашних суток) и остальные, §6.2. */
async function callbackKeys(sql: Sql, viewer: Viewer, q: ColumnSelect): Promise<KeyRow[]> {
  const k = cur(q.cursor);
  const f = q.filters;
  const t = q.bounds.tomorrowStart;
  // Первая часть читается, пока курсор не ушёл во вторую; вторая — с начала либо с ключа курсора
  const firstOn = !k.on || k.part === 0;
  const firstCur = k.on && k.part === 0;
  const secondCur = k.on && k.part === 1;
  return scoped(sql)<KeyRow>`
    SELECT u.id, u.part, u.k1, u.k2, 0::bigint AS k3 FROM (
      (SELECT c.id, 0 AS part, c.heat::bigint AS k1, COALESCE(c.next_call_at, ${KEY_MAX}::bigint) AS k2
         FROM cards c
        WHERE ${firstOn}::boolean AND c.space_id = ${q.spaceId} AND c.state = ANY(${[...q.states]}::text[]) AND c.hold_reason = ''
          AND c.next_call_at < ${t}::bigint
          AND ${scopeSql(viewer, 'card', 'card.read')}
          AND (${f.owner}::text IS NULL OR c.owner_user_id = ${f.owner}::text)
          AND (NOT ${f.attendedGroup}::boolean OR c.attended_group_at IS NOT NULL)
          AND (NOT ${f.attendedIndividual}::boolean OR c.attended_individual_at IS NOT NULL)
          AND (NOT ${f.noShow}::boolean OR (c.last_no_show_at IS NOT NULL AND c.last_no_show_at > COALESCE(GREATEST(c.attended_group_at, c.attended_individual_at), 0)))
          AND (NOT ${f.purchased}::boolean OR c.purchases_total > 0)
          AND (${f.callbackReason}::text IS NULL OR c.callback_reason = ${f.callbackReason}::text)
          AND (NOT ${firstCur}::boolean OR c.heat < ${k.k1}::bigint
               OR (c.heat = ${k.k1}::bigint AND (COALESCE(c.next_call_at, ${KEY_MAX}::bigint) > ${k.k2}::bigint
                    OR (COALESCE(c.next_call_at, ${KEY_MAX}::bigint) = ${k.k2}::bigint AND c.id > ${k.id}::text))))
        ORDER BY c.heat DESC, c.next_call_at, c.id
        LIMIT ${q.limit})
      UNION ALL
      (SELECT c.id, 1 AS part, c.heat::bigint AS k1, COALESCE(c.next_call_at, ${KEY_MAX}::bigint) AS k2
         FROM cards c
        WHERE c.space_id = ${q.spaceId} AND c.state = ANY(${[...q.states]}::text[]) AND c.hold_reason = ''
          AND (c.next_call_at IS NULL OR c.next_call_at >= ${t}::bigint)
          AND ${scopeSql(viewer, 'card', 'card.read')}
          AND (${f.owner}::text IS NULL OR c.owner_user_id = ${f.owner}::text)
          AND (NOT ${f.today}::boolean)
          AND (NOT ${f.attendedGroup}::boolean OR c.attended_group_at IS NOT NULL)
          AND (NOT ${f.attendedIndividual}::boolean OR c.attended_individual_at IS NOT NULL)
          AND (NOT ${f.noShow}::boolean OR (c.last_no_show_at IS NOT NULL AND c.last_no_show_at > COALESCE(GREATEST(c.attended_group_at, c.attended_individual_at), 0)))
          AND (NOT ${f.purchased}::boolean OR c.purchases_total > 0)
          AND (${f.callbackReason}::text IS NULL OR c.callback_reason = ${f.callbackReason}::text)
          AND (NOT ${secondCur}::boolean OR c.heat < ${k.k1}::bigint
               OR (c.heat = ${k.k1}::bigint AND (COALESCE(c.next_call_at, ${KEY_MAX}::bigint) > ${k.k2}::bigint
                    OR (COALESCE(c.next_call_at, ${KEY_MAX}::bigint) = ${k.k2}::bigint AND c.id > ${k.id}::text))))
        ORDER BY c.heat DESC, c.next_call_at NULLS LAST, c.id
        LIMIT ${q.limit})
    ) u
    ORDER BY u.part, u.k1 DESC, u.k2, u.id
    LIMIT ${q.limit}`;
}

/** Страница ключей «Договорились»: порядок — дата записи открытой сделки ↑; виды записи — по колонке (§2.1). */
async function agreedKeys(sql: Sql, viewer: Viewer, q: ColumnSelect): Promise<KeyRow[]> {
  const k = cur(q.cursor);
  const f = q.filters;
  return scoped(sql)<KeyRow>`
    SELECT t.id, 0 AS part, t.k1, 0::bigint AS k2, 0::bigint AS k3 FROM (
      SELECT c.id, COALESCE(bk.starts_at, ${KEY_MAX}::bigint) AS k1, bk.event_type_key
        FROM cards c
        LEFT JOIN LATERAL (
          SELECT b.event_type_key, b.starts_at
            FROM bookings b JOIN deals d ON d.id = b.deal_id AND d.status = 'open' AND d.card_id = c.id
           WHERE b.status IN ('registered','confirmed','attended','no_show')
           ORDER BY b.starts_at DESC, b.id LIMIT 1) bk ON TRUE
       WHERE c.space_id = ${q.spaceId} AND c.state = 'agreed'
         AND ${scopeSql(viewer, 'card', 'card.read')}
         AND (${f.owner}::text IS NULL OR c.owner_user_id = ${f.owner}::text)
         AND (NOT ${f.today}::boolean OR (c.next_call_at IS NOT NULL AND c.next_call_at < ${q.bounds.tomorrowStart}::bigint))
         AND (NOT ${f.attendedGroup}::boolean OR c.attended_group_at IS NOT NULL)
         AND (NOT ${f.attendedIndividual}::boolean OR c.attended_individual_at IS NOT NULL)
         AND (NOT ${f.noShow}::boolean OR (c.last_no_show_at IS NOT NULL AND c.last_no_show_at > COALESCE(GREATEST(c.attended_group_at, c.attended_individual_at), 0)))
         AND (NOT ${f.purchased}::boolean OR c.purchases_total > 0)) t
     WHERE (t.event_type_key = ANY(${[...q.agreed.types]}::text[])
            OR (${q.agreed.fallback}::boolean AND (t.event_type_key IS NULL OR NOT t.event_type_key = ANY(${[...q.agreed.allTypes]}::text[]))))
       AND (NOT ${k.on}::boolean OR (t.k1, t.id) > (${k.k1}::bigint, ${k.id}::text))
     ORDER BY t.k1, t.id
     LIMIT ${q.limit}`;
}

/** Страница ключей «Новые», «Покупка» и закрытых колонок: порядок задаёт вид колонки (§2.1). */
async function simpleKeys(sql: Sql, viewer: Viewer, q: ColumnSelect): Promise<KeyRow[]> {
  const k = cur(q.cursor);
  const f = q.filters;
  return scoped(sql)<KeyRow>`
    SELECT t.id, 0 AS part, t.k1, t.k2, t.k3 FROM (
      SELECT c.id,
             CASE ${q.kind}::text WHEN 'new' THEN -c.heat::bigint WHEN 'client' THEN -COALESCE(c.last_purchase_at, 0)
                                  ELSE -COALESCE(c.closed_at, 0) END AS k1,
             CASE WHEN ${q.kind}::text = 'new' AND NOT EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.client_id AND p.is_working AND p.kind = 'mobile')
                  THEN 1::bigint ELSE 0::bigint END AS k2,
             CASE WHEN ${q.kind}::text = 'new' THEN COALESCE(c.assigned_at, ${KEY_MAX}::bigint) ELSE 0::bigint END AS k3
        FROM cards c
       WHERE c.space_id = ${q.spaceId} AND c.state = ANY(${[...q.states]}::text[])
         AND (${q.kind}::text <> 'new' OR (c.hold_reason = '' AND c.owner_user_id IS NOT NULL))
         AND (${q.closedFrom}::bigint IS NULL OR c.closed_at >= ${q.closedFrom}::bigint)
         AND ${scopeSql(viewer, 'card', 'card.read')}
         AND (${f.owner}::text IS NULL OR c.owner_user_id = ${f.owner}::text)
         AND (NOT ${f.today}::boolean OR (c.next_call_at IS NOT NULL AND c.next_call_at < ${q.bounds.tomorrowStart}::bigint))
         AND (NOT ${f.attendedGroup}::boolean OR c.attended_group_at IS NOT NULL)
         AND (NOT ${f.attendedIndividual}::boolean OR c.attended_individual_at IS NOT NULL)
         AND (NOT ${f.noShow}::boolean OR (c.last_no_show_at IS NOT NULL AND c.last_no_show_at > COALESCE(GREATEST(c.attended_group_at, c.attended_individual_at), 0)))
         AND (NOT ${f.purchased}::boolean OR c.purchases_total > 0)
         AND (${f.callbackReason}::text IS NULL OR c.callback_reason = ${f.callbackReason}::text)) t
     WHERE NOT ${k.on}::boolean OR (t.k1, t.k2, t.k3, t.id) > (${k.k1}::bigint, ${k.k2}::bigint, ${k.k3}::bigint, ${k.id}::text)
     ORDER BY t.k1, t.k2, t.k3, t.id
     LIMIT ${q.limit}`;
}

/** Страница ключей колонки: id в порядке колонки и ключи для курсора «Ещё». */
export async function selectColumnKeys(sql: Sql, viewer: Viewer, q: ColumnSelect): Promise<KeyRow[]> {
  const rows = q.kind === 'callback' ? await callbackKeys(sql, viewer, q) : q.kind === 'agreed' ? await agreedKeys(sql, viewer, q) : await simpleKeys(sql, viewer, q);
  return rows.map((r) => ({ id: r.id, part: r.part, k1: Number(r.k1), k2: Number(r.k2), k3: Number(r.k3) }));
}

/** Поиск по своим: id карточек в пространстве, чьё название, БИН или номер подходит под шаблон. Чужие в выборку не попадают. */
export async function selectSearchIds(sql: Sql, viewer: Viewer, a: { spaceId: string; p1: string; p2: string; limit: number }): Promise<string[]> {
  const rows = await scoped(sql)<{ id: string }>`
    SELECT c.id
      FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.space_id = ${a.spaceId} AND ${scopeSql(viewer, 'card', 'card.read')}
       AND cl.merged_into_id IS NULL AND c.hold_reason <> 'merged'
       AND (cl.search_norm LIKE ${a.p1}::text OR cl.search_norm LIKE ${a.p2}::text)
     ORDER BY COALESCE(c.last_touch_at, c.created_at) DESC, c.id
     LIMIT ${a.limit}`;
  return rows.map((r) => r.id);
}

/** Строка плитки: карточка, название клиента, запись открытой сделки (для `agreed`), признак мобильного. */
export interface BoardRowDb {
  id: string;
  clientId: string;
  name: string;
  state: string;
  version: number;
  ownerUserId: string | null;
  holdReason: string;
  attempts: number;
  nextCallAt: number | null;
  nextCallPrecision: 'time' | 'day';
  callbackReason: string;
  callbackTouches: number;
  lpr: string;
  isTarget: string;
  attendedGroupAt: number | null;
  attendedIndividualAt: number | null;
  lastNoShowAt: number | null;
  lastNoShowKind: string;
  purchasesTotal: number;
  lastPurchaseAt: number | null;
  closedAt: number | null;
  closeReasonCode: string;
  cardCustom: Record<string, unknown>;
  clientCustom: Record<string, unknown>;
  bookingType: string | null;
  bookingStatus: string | null;
  bookingStartsAt: number | null;
}

/** Строки по id под тем же охватом; порядок — как у `ids`. */
export async function selectBoardRows(sql: Sql, viewer: Viewer, ids: readonly string[]): Promise<BoardRowDb[]> {
  if (ids.length === 0) return [];
  const rows = await scoped(sql)<BoardRowDb>`
    SELECT c.id, c.client_id, cl.name, c.state, c.version, c.owner_user_id, c.hold_reason, c.attempts, c.next_call_at, c.next_call_precision,
           c.callback_reason, c.callback_touches, c.lpr, c.is_target, c.attended_group_at, c.attended_individual_at,
           c.last_no_show_at, c.last_no_show_kind, c.purchases_total, c.last_purchase_at, c.closed_at, c.close_reason_code,
           c.custom AS card_custom, cl.custom AS client_custom,
           bk.event_type_key AS booking_type, bk.status AS booking_status, bk.starts_at AS booking_starts_at
      FROM cards c JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN LATERAL (
        SELECT b.event_type_key, b.status, b.starts_at
          FROM bookings b JOIN deals d ON d.id = b.deal_id AND d.status = 'open' AND d.card_id = c.id
         WHERE c.state = 'agreed' AND b.status IN ('registered','confirmed','attended','no_show')
         ORDER BY b.starts_at DESC, b.id LIMIT 1) bk ON TRUE
     WHERE c.id = ANY(${[...ids]}::text[]) AND ${scopeSql(viewer, 'card', 'card.read')}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}
