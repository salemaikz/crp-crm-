// SQL передачи клиентов и дел отключённого сотрудника (B9a, docs/tasks-team-design.md §6.3). Пакетная запись: одна
// команда на таблицу вместо цикла по карточкам; семантика совпадает с ядром `calling.applyOutcome({type:'transfer'})`
// (строки — TRANSFER_ROWS в plan.ts, паритет проверяет tests/unit/team/transferParity.test.ts).
// Чтение для людей — через scopeSql (client.transfer); служебные чтения (отключение сотрудника, напарники по паре)
// идут без охвата: у администратора нет роли в пространстве, а ограничением служит пространство и прежний владелец.
// Порядок блокировок: advisory (DISTRIBUTION_LOCK_KEY) → карточки по id → остальное.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access/types';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import { DISTRIBUTION_LOCK_KEY } from '@/server/platform/db/locks';
import { TRANSFER_ROWS } from './plan';

/** Рабочие состояния (PROCESS 3.1): их передают всегда; остальные — только в охвате «все». */
export const WORKING_STATES = ['new', 'retry', 'callback', 'agreed', 'client'] as const;
/** Больше карточек за одну операцию не берём (400 `too_many`): делить по состояниям. */
export const MAX_BULK_CARDS = 5000;

const ACTIVE_BOOKING = ['registered', 'confirmed'] as const;

/** Начало транзакции передачи: потолок ожидания 10 с и сериализация с раздачей. Первая команда транзакции. */
export async function lockTransfer(tx: Sql): Promise<void> {
  await tx`SET LOCAL lock_timeout = '10s'`;
  await tx`SELECT pg_advisory_xact_lock(${DISTRIBUTION_LOCK_KEY})`;
}

export type TransferScope = 'working' | 'all';

export interface SourceCard {
  id: string;
  clientId: string;
  ownerUserId: string | null;
  actingUserId: string | null;
  state: string;
  version: number;
}

const stateFilter = (scope: TransferScope): string[] => (scope === 'working' ? [...WORKING_STATES] : []);

/** Карточки сотрудника по охвату `working`/`all` (без слитых), под блокировкой, по id. Охват зрителя — в SQL. */
export async function lockSourceCards(tx: Sql, viewer: Viewer, a: { spaceId: string; fromUserId: string; scope: TransferScope; limit: number }): Promise<SourceCard[]> {
  const states = stateFilter(a.scope);
  return scoped(tx)<SourceCard>`
    SELECT c.id, c.client_id, c.owner_user_id, c.acting_user_id, c.state, c.version FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.fromUserId} AND c.hold_reason <> 'merged'
       AND (${a.scope === 'all'}::boolean OR c.state = ANY(${states}::text[])) AND ${scopeSql(viewer, 'card', 'client.transfer')}
     ORDER BY c.id LIMIT ${a.limit} FOR UPDATE OF c`;
}

/** Сколько карточек подходит (с предельным числом): отсекает слишком большие операции до блокировок. */
export async function countSourceCards(sql: Sql, viewer: Viewer, a: { spaceId: string; fromUserId: string; scope: TransferScope; limit: number }): Promise<{ byState: Record<string, number>; total: number }> {
  const states = stateFilter(a.scope);
  const rows = await scoped(sql)<{ state: string; n: number }>`
    SELECT s.state, count(*)::int AS n FROM (
      SELECT c.state FROM cards c
       WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.fromUserId} AND c.hold_reason <> 'merged'
         AND (${a.scope === 'all'}::boolean OR c.state = ANY(${states}::text[])) AND ${scopeSql(viewer, 'card', 'client.transfer')}
       LIMIT ${a.limit}) s GROUP BY s.state`;
  const byState: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byState[r.state] = r.n;
    total += r.n;
  }
  return { byState, total };
}

/** Задачи, сделки и записи набора карточек сотрудника — счётчики предпросмотра (те же условия, что и у записи). */
export async function countRelated(sql: Sql, viewer: Viewer, a: { spaceId: string; fromUserId: string; scope: TransferScope; now: number }): Promise<{ tasks: number; deals: number; bookings: number }> {
  const states = stateFilter(a.scope);
  const q = scoped(sql);
  const [t] = await q<{ n: number }>`
    SELECT count(*)::int AS n FROM tasks t JOIN cards c ON c.client_id = t.client_id AND c.space_id = t.space_id
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.fromUserId} AND c.hold_reason <> 'merged'
       AND (${a.scope === 'all'}::boolean OR c.state = ANY(${states}::text[])) AND ${scopeSql(viewer, 'card', 'client.transfer')}
       AND t.status = 'open' AND (t.assignee_user_id = c.owner_user_id OR t.assignee_user_id = c.acting_user_id)`;
  const [d] = await q<{ n: number }>`
    SELECT count(*)::int AS n FROM deals d JOIN cards c ON c.client_id = d.client_id AND c.space_id = d.space_id
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.fromUserId} AND c.hold_reason <> 'merged'
       AND (${a.scope === 'all'}::boolean OR c.state = ANY(${states}::text[])) AND ${scopeSql(viewer, 'card', 'client.transfer')}
       AND d.status = 'open'`;
  const [b] = await q<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings b JOIN cards c ON c.client_id = b.client_id AND c.space_id = b.space_id
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.fromUserId} AND c.hold_reason <> 'merged'
       AND (${a.scope === 'all'}::boolean OR c.state = ANY(${states}::text[])) AND ${scopeSql(viewer, 'card', 'client.transfer')}
       AND b.status = ANY(${[...ACTIVE_BOOKING]}::text[]) AND b.starts_at > ${a.now}`;
  return { tasks: t?.n ?? 0, deals: d?.n ?? 0, bookings: b?.n ?? 0 };
}

/** Пары двойников (`open|distinct`) среди клиентов набора. */
export async function selectPairsAmong(sql: Sql, clientIds: readonly string[]): Promise<{ aClientId: string; bClientId: string }[]> {
  if (clientIds.length < 2) return [];
  const ids = [...clientIds];
  return sql<{ aClientId: string; bClientId: string }>`
    SELECT p.a_client_id, p.b_client_id FROM dup_pairs p
     WHERE p.status IN ('open','distinct') AND p.a_client_id = ANY(${ids}::text[]) AND p.b_client_id = ANY(${ids}::text[])`;
}

/** id клиентов набора карточек сотрудника (для семей в предпросмотре), по охвату зрителя. */
export async function selectSourceClients(sql: Sql, viewer: Viewer, a: { spaceId: string; fromUserId: string; scope: TransferScope; limit: number }): Promise<{ id: string; clientId: string }[]> {
  const states = stateFilter(a.scope);
  return scoped(sql)<{ id: string; clientId: string }>`
    SELECT c.id, c.client_id FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.fromUserId} AND c.hold_reason <> 'merged'
       AND (${a.scope === 'all'}::boolean OR c.state = ANY(${states}::text[])) AND ${scopeSql(viewer, 'card', 'client.transfer')}
     ORDER BY c.id LIMIT ${a.limit}`;
}

/**
 * Двойники клиента с тем же владельцем в рабочих состояниях (D-038, D-254): транзитивно по парам `open|distinct`;
 * в цепочку входят только карточки, которые сами подходят (тот же владелец, рабочее состояние).
 */
export async function selectRelatedCards(sql: Sql, a: { spaceId: string; ownerUserId: string; seedClientId: string }): Promise<{ id: string; clientId: string }[]> {
  return sql<{ id: string; clientId: string }>`
    WITH RECURSIVE fam(client_id) AS (
      SELECT ${a.seedClientId}::text
      UNION
      SELECT CASE WHEN p.a_client_id = f.client_id THEN p.b_client_id ELSE p.a_client_id END
        FROM fam f
        JOIN dup_pairs p ON p.status IN ('open','distinct') AND (p.a_client_id = f.client_id OR p.b_client_id = f.client_id)
        JOIN cards o ON o.client_id = CASE WHEN p.a_client_id = f.client_id THEN p.b_client_id ELSE p.a_client_id END
                    AND o.space_id = ${a.spaceId} AND o.owner_user_id = ${a.ownerUserId}
                    AND o.state = ANY(${[...WORKING_STATES]}::text[]) AND o.hold_reason <> 'merged'
    )
    SELECT c.id, c.client_id FROM cards c JOIN fam ON fam.client_id = c.client_id
     WHERE c.space_id = ${a.spaceId} AND c.client_id <> ${a.seedClientId}
     ORDER BY c.id`;
}

/** Карточки по id под блокировкой, по id, с охватом зрителя. Чужие и несуществующие не возвращаются. */
export async function lockCardsByIds(tx: Sql, viewer: Viewer, a: { spaceId: string; ids: readonly string[] }): Promise<SourceCard[]> {
  const ids = [...a.ids];
  return scoped(tx)<SourceCard>`
    SELECT c.id, c.client_id, c.owner_user_id, c.acting_user_id, c.state, c.version FROM cards c
     WHERE c.id = ANY(${ids}::text[]) AND c.space_id = ${a.spaceId} AND ${scopeSql(viewer, 'card', 'client.transfer')}
     ORDER BY c.id FOR UPDATE OF c`;
}

/** Служебная выборка отключаемого: его карточки и карточки, где он временный владелец; под блокировкой, по id. */
export async function lockStaffCards(tx: Sql, a: { spaceId: string; userId: string }): Promise<(SourceCard & { callsTotal: number })[]> {
  return tx<SourceCard & { callsTotal: number }>`
    SELECT c.id, c.client_id, c.owner_user_id, c.acting_user_id, c.state, c.version, c.calls_total FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.hold_reason <> 'merged' AND (c.owner_user_id = ${a.userId} OR c.acting_user_id = ${a.userId})
     ORDER BY c.id FOR UPDATE OF c`;
}

/** Счётчики карточек сотрудника для мастера отключения: по состояниям (его), временный владелец, задачи/сделки/записи. */
export async function countStaffLoad(sql: Sql, a: { spaceId: string; userId: string; now: number }): Promise<{ byState: Record<string, number>; actingCards: number; tasks: number; deals: number; bookings: number }> {
  const rows = await sql<{ state: string; n: number }>`
    SELECT c.state, count(*)::int AS n FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id = ${a.userId} AND c.hold_reason <> 'merged' GROUP BY c.state`;
  const [acting] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM cards c WHERE c.space_id = ${a.spaceId} AND c.acting_user_id = ${a.userId} AND c.owner_user_id <> ${a.userId}`;
  const [tasks] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tasks t WHERE t.space_id = ${a.spaceId} AND t.status = 'open' AND t.assignee_user_id = ${a.userId}`;
  const [deals] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM deals d WHERE d.space_id = ${a.spaceId} AND d.status = 'open' AND d.owner_user_id = ${a.userId}`;
  const [bookings] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.responsible_user_id = ${a.userId} AND b.status = ANY(${[...ACTIVE_BOOKING]}::text[]) AND b.starts_at > ${a.now}::bigint`;
  return { byState: Object.fromEntries(rows.map((r) => [r.state, r.n])), actingCards: acting?.n ?? 0, tasks: tasks?.n ?? 0, deals: deals?.n ?? 0, bookings: bookings?.n ?? 0 };
}

/** Получатель активен в пространстве. */
export interface MemberRow {
  userId: string;
  roleKey: string;
  createdAt: number;
}

/** Активные сотрудники пространства с ролями (получатели, кандидаты в «срочного»); отключённые учётки не входят. */
export async function selectActiveMembers(sql: Sql, a: { spaceId: string; userIds?: readonly string[] }): Promise<MemberRow[]> {
  const ids = a.userIds ? [...a.userIds] : null;
  return sql<MemberRow>`
    SELECT m.user_id, m.role_key, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND (${ids}::text[] IS NULL OR m.user_id = ANY(${ids}::text[]))
     ORDER BY m.created_at, m.user_id`;
}

/** Сотрудники пространства для выбора «от кого» и «кому»: члены любого статуса, активность считается по учётке и членству. */
export async function selectSpaceStaff(sql: Sql, spaceId: string): Promise<{ userId: string; name: string; roleKey: string; active: boolean }[]> {
  return sql<{ userId: string; name: string; roleKey: string; active: boolean }>`
    SELECT m.user_id, u.name, m.role_key, (m.status = 'active' AND u.status = 'active') AS active
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = ${spaceId} ORDER BY u.name, m.user_id`;
}

/** Карточка для диалога передачи (без блокировки), в охвате зрителя. */
export async function selectTransferCard(sql: Sql, viewer: Viewer, a: { spaceId: string; cardId: string }): Promise<SourceCard | null> {
  const rows = await scoped(sql)<SourceCard>`
    SELECT c.id, c.client_id, c.owner_user_id, c.acting_user_id, c.state, c.version FROM cards c
     WHERE c.id = ${a.cardId} AND c.space_id = ${a.spaceId} AND ${scopeSql(viewer, 'card', 'client.transfer')}`;
  return rows[0] ?? null;
}

/** Пространства, где у сотрудника есть членство (любого статуса): отключение переносит дела в каждом. */
export async function selectMemberSpaces(sql: Sql, userId: string): Promise<{ spaceId: string; roleKey: string }[]> {
  return sql<{ spaceId: string; roleKey: string }>`SELECT m.space_id, m.role_key FROM memberships m WHERE m.user_id = ${userId} ORDER BY m.space_id`;
}

/** Строка пакета: карточка, её клиент, прежний владелец, временный (может быть пуст) и получатель. */
export interface Move {
  cardId: string;
  clientId: string;
  fromUserId: string | null;
  actingUserId: string | null;
  toUserId: string;
}

export interface WriteCounts {
  cards: number;
  tasks: number;
  deals: number;
  bookings: number;
  snapshots: number;
}

interface Arrays {
  ids: string[];
  clients: string[];
  froms: (string | null)[];
  actings: (string | null)[];
  tos: string[];
}

const arraysOf = (moves: readonly Move[]): Arrays => ({
  ids: moves.map((m) => m.cardId),
  clients: moves.map((m) => m.clientId),
  froms: moves.map((m) => m.fromUserId),
  actings: moves.map((m) => m.actingUserId),
  tos: moves.map((m) => m.toUserId),
});

/** Строки «до» в `change_snapshots` (D-062): карточки и то, что передача меняет у клиентов набора. Пишется до правок. */
async function writeSnapshots(tx: Sql, a: { spaceId: string; opId: string; actorId: string | null; now: number; arrays: Arrays }): Promise<number> {
  const { ids, clients, froms, actings } = a.arrays;
  const base = { op: a.opId, actor: a.actorId, now: a.now };
  const cards = await tx<{ id: string }>`
    INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
    SELECT gen_random_uuid()::text, ${base.op}, 'bulk_transfer', 'cards', c.id, c.client_id, to_jsonb(c), ${base.actor}, ${base.now}::bigint
      FROM cards c WHERE c.id = ANY(${ids}::text[]) RETURNING id`;
  const tasks = await tx<{ id: string }>`
    INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
    SELECT gen_random_uuid()::text, ${base.op}, 'bulk_transfer', 'tasks', t.id, t.client_id, to_jsonb(t), ${base.actor}, ${base.now}::bigint
      FROM tasks t JOIN unnest(${clients}::text[], ${froms}::text[], ${actings}::text[]) AS w(client_id, f, a) ON t.client_id = w.client_id
     WHERE t.space_id = ${a.spaceId} AND t.status = 'open' AND t.assignee_user_id IN (w.f, w.a) RETURNING id`;
  const deals = await tx<{ id: string }>`
    INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
    SELECT gen_random_uuid()::text, ${base.op}, 'bulk_transfer', 'deals', d.id, d.client_id, to_jsonb(d), ${base.actor}, ${base.now}::bigint
      FROM deals d WHERE d.space_id = ${a.spaceId} AND d.client_id = ANY(${clients}::text[]) AND d.status = 'open' RETURNING id`;
  const bookings = await tx<{ id: string }>`
    INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
    SELECT gen_random_uuid()::text, ${base.op}, 'bulk_transfer', 'bookings', b.id, b.client_id, to_jsonb(b), ${base.actor}, ${base.now}::bigint
      FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.client_id = ANY(${clients}::text[])
       AND b.status = ANY(${[...ACTIVE_BOOKING]}::text[]) AND b.starts_at > ${a.now}::bigint RETURNING id`;
  return cards.length + tasks.length + deals.length + bookings.length;
}

/**
 * Применить передачу пакетом (§6.3). Карточки уже заблокированы и проверены вызывающим. Что делает для каждой
 * карточки `card → to`: владелец = получатель, временный снят, версия + 1; открытые задачи прежнего и временного
 * владельцев и все открытые сделки клиента — получателю; будущие записи — ответственный получатель (автор не
 * меняется, D-042); журнал `transfer` (лимит не тратится); событие ленты `card.transferred`.
 * Уведомления вызывающий пишет сам: у отключения и обычной передачи они разные.
 */
export async function writeMoves(
  tx: Sql,
  a: { spaceId: string; opId: string; actorId: string | null; now: number; day: string; moves: readonly Move[]; snapshot: boolean },
): Promise<WriteCounts> {
  const out: WriteCounts = { cards: 0, tasks: 0, deals: 0, bookings: 0, snapshots: 0 };
  if (a.moves.length === 0) return out;
  const arrays = arraysOf(a.moves);
  const { ids, clients, froms, actings, tos } = arrays;
  if (a.snapshot) out.snapshots = await writeSnapshots(tx, { spaceId: a.spaceId, opId: a.opId, actorId: a.actorId, now: a.now, arrays });

  const cards = await tx<{ id: string }>`
    UPDATE cards c SET owner_user_id = w.to_user, acting_user_id = NULL, acting_until_day = '', version = c.version + ${TRANSFER_ROWS.versionDelta}, updated_at = ${a.now}::bigint
      FROM unnest(${ids}::text[], ${tos}::text[]) AS w(id, to_user)
     WHERE c.id = w.id AND c.space_id = ${a.spaceId} RETURNING c.id`;
  out.cards = cards.length;

  const tasks = await tx<{ id: string }>`
    UPDATE tasks t SET assignee_user_id = w.to_user
      FROM unnest(${clients}::text[], ${froms}::text[], ${actings}::text[], ${tos}::text[]) AS w(client_id, f, a, to_user)
     WHERE t.space_id = ${a.spaceId} AND t.client_id = w.client_id AND t.status = 'open' AND t.assignee_user_id IN (w.f, w.a) RETURNING t.id`;
  out.tasks = tasks.length;

  const deals = await tx<{ id: string }>`
    UPDATE deals d SET owner_user_id = w.to_user, version = d.version + 1, updated_at = ${a.now}::bigint
      FROM unnest(${clients}::text[], ${tos}::text[]) AS w(client_id, to_user)
     WHERE d.space_id = ${a.spaceId} AND d.client_id = w.client_id AND d.status = 'open' RETURNING d.id`;
  out.deals = deals.length;

  const bookings = await tx<{ id: string }>`
    UPDATE bookings b SET responsible_user_id = w.to_user, version = b.version + 1, updated_at = ${a.now}::bigint
      FROM unnest(${clients}::text[], ${tos}::text[]) AS w(client_id, to_user)
     WHERE b.space_id = ${a.spaceId} AND b.client_id = w.client_id AND b.status = ANY(${[...ACTIVE_BOOKING]}::text[]) AND b.starts_at > ${a.now}::bigint
    RETURNING b.id`;
  out.bookings = bookings.length;

  await tx`
    INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
    SELECT gen_random_uuid()::text, ${a.spaceId}::text, w.id, w.f, w.to_user, ${TRANSFER_ROWS.assignKind}::text, ${TRANSFER_ROWS.countsToCap}::boolean,
           ${a.opId}::text, ${a.day}::text, ${a.actorId}::text, ${a.now}::bigint
      FROM unnest(${ids}::text[], ${froms}::text[], ${tos}::text[]) AS w(id, f, to_user)`;

  await tx`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    SELECT gen_random_uuid()::text, w.client_id, ${a.spaceId}::text, NULL, ${TRANSFER_ROWS.feedKind}::text, ${a.actorId}::text, ${a.now}::bigint, '', '',
           jsonb_build_object('fromUserId', w.f, 'toUserId', w.to_user)
      FROM unnest(${clients}::text[], ${froms}::text[], ${tos}::text[]) AS w(client_id, f, to_user)`;
  return out;
}

/** Одно уведомление получателю на операцию: `params {count}`, повтор по `dedupe_key` не задваивается. Без имён и номеров. */
export async function insertCountNotifications(
  tx: Sql,
  a: { kind: string; entityType: string; entityId: string; counts: ReadonlyMap<string, number>; dedupe: (userId: string) => string; now: number },
): Promise<void> {
  for (const [userId, count] of [...a.counts].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    await tx`
      INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
      VALUES (${newId()}, ${userId}, ${a.kind}, ${a.entityType}, ${a.entityId}, ${jsonParam({ count })}, ${a.dedupe(userId)}, ${a.now}, ${a.now})
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  }
}

/** Повтор операции: получатели и числа из журнала раздачи по `run_id`. Пусто — операции не было. */
export async function selectPriorTransfer(tx: Sql, a: { spaceId: string; opId: string }): Promise<{ toUserId: string; n: number }[]> {
  return tx<{ toUserId: string; n: number }>`
    SELECT to_user_id, count(*)::int AS n FROM assign_log
     WHERE space_id = ${a.spaceId} AND run_id = ${a.opId} AND kind = ${TRANSFER_ROWS.assignKind}
     GROUP BY to_user_id ORDER BY to_user_id`;
}

// ---------------------------------------------------------------------------
// Отключение сотрудника: что не передача (§6.4 п. 2, 4, 6)
// ---------------------------------------------------------------------------

/**
 * Где отключённый был временным владельцем: временный — получатель (срок прежний) либо, если получатель сам владелец
 * или принять некому, временный снимается. Журнал `absence` (к тому, кто теперь отвечает, нужно для D-175), лента `card.acting`.
 */
export async function replaceActing(
  tx: Sql,
  a: { spaceId: string; opId: string; actorId: string | null; now: number; day: string; items: readonly { cardId: string; toUserId: string | null; fromUserId: string }[] },
): Promise<number> {
  if (a.items.length === 0) return 0;
  const rows = await tx<{ id: string; clientId: string; ownerUserId: string; actingUserId: string | null; actingUntilDay: string }>`
    UPDATE cards c SET acting_user_id = w.to_user,
                       acting_until_day = CASE WHEN w.to_user IS NULL THEN '' ELSE c.acting_until_day END,
                       version = c.version + 1, updated_at = ${a.now}::bigint
      FROM unnest(${a.items.map((i) => i.cardId)}::text[], ${a.items.map((i) => i.toUserId)}::text[]) AS w(id, to_user)
     WHERE c.id = w.id AND c.space_id = ${a.spaceId}
    RETURNING c.id, c.client_id, c.owner_user_id, c.acting_user_id, c.acting_until_day`;
  const from = new Map(a.items.map((i) => [i.cardId, i.fromUserId]));
  await tx`
    INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
    SELECT gen_random_uuid()::text, ${a.spaceId}::text, w.id, w.f, w.to_user, 'absence', FALSE, ${a.opId}::text, ${a.day}::text, ${a.actorId}::text, ${a.now}::bigint
      FROM unnest(${rows.map((r) => r.id)}::text[], ${rows.map((r) => from.get(r.id) ?? null)}::text[], ${rows.map((r) => r.actingUserId ?? r.ownerUserId)}::text[]) AS w(id, f, to_user)`;
  await tx`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    SELECT gen_random_uuid()::text, w.client_id, ${a.spaceId}::text, NULL, 'card.acting', ${a.actorId}::text, ${a.now}::bigint, '', '',
           jsonb_build_object('actingUserId', w.acting, 'untilDay', w.until_day)
      FROM unnest(${rows.map((r) => r.clientId)}::text[], ${rows.map((r) => r.actingUserId)}::text[], ${rows.map((r) => r.actingUntilDay)}::text[]) AS w(client_id, acting, until_day)`;
  return rows.length;
}

/** Оставшиеся открытые задачи отключённого в пространстве → получателю (по клиенту, без привязки к карточкам). */
export async function reassignOpenTasksOf(tx: Sql, a: { spaceId: string; fromUserId: string; toUserId: string }): Promise<number> {
  const rows = await tx<{ id: string }>`
    UPDATE tasks SET assignee_user_id = ${a.toUserId}
     WHERE space_id = ${a.spaceId} AND status = 'open' AND assignee_user_id = ${a.fromUserId} RETURNING id`;
  return rows.length;
}

/** Будущие активные записи, где ответственный — отключённый, и открытые сделки, где он владелец → получателю. */
export async function reassignBookingsAndDealsOf(tx: Sql, a: { spaceId: string; fromUserId: string; toUserId: string; now: number }): Promise<{ bookings: number; deals: number }> {
  const bookings = await tx<{ id: string }>`
    UPDATE bookings SET responsible_user_id = ${a.toUserId}, version = version + 1, updated_at = ${a.now}::bigint
     WHERE space_id = ${a.spaceId} AND responsible_user_id = ${a.fromUserId} AND status = ANY(${[...ACTIVE_BOOKING]}::text[]) AND starts_at > ${a.now}::bigint
    RETURNING id`;
  const deals = await tx<{ id: string }>`
    UPDATE deals SET owner_user_id = ${a.toUserId}, version = version + 1, updated_at = ${a.now}::bigint
     WHERE space_id = ${a.spaceId} AND owner_user_id = ${a.fromUserId} AND status = 'open' RETURNING id`;
  return { bookings: bookings.length, deals: deals.length };
}

/** Неотменённые отсутствия отключённого — отменяются (временные владельцы с них уже сняты или заменены). */
export async function cancelAbsencesOf(tx: Sql, a: { spaceId: string; userId: string; now: number }): Promise<number> {
  const rows = await tx<{ id: string }>`
    UPDATE absences SET cancelled_at = ${a.now}::bigint WHERE space_id = ${a.spaceId} AND user_id = ${a.userId} AND cancelled_at IS NULL RETURNING id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Чистка
// ---------------------------------------------------------------------------

/** Снимки старше срока (D-062, 30 дней): часть задачи `purge`. Пачками, чтобы не держать долгую блокировку. */
export async function deleteSnapshotsBefore(sql: Sql, before: number, batch: number): Promise<number> {
  const rows = await sql<{ id: string }>`
    DELETE FROM change_snapshots WHERE id IN (SELECT id FROM change_snapshots WHERE created_at < ${before}::bigint LIMIT ${batch}) RETURNING id`;
  return rows.length;
}
