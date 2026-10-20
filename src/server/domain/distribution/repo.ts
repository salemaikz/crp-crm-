// Весь SQL раздачи (docs/distribution-design.md §3–§5). Карточки пула и журнал читаются через scopeSql там,
// где есть Viewer; напарники по паре и сводка нагрузки читаются без охвата: это служебные чтения пространства
// (владелец двойника и расход лимита нужны правилам D-038, D-174 независимо от охвата РОП), наружу идут
// только счётчики и id. Порядок блокировок: advisory (DISTRIBUTION_LOCK_KEY) → карточки по id.
import type { distribution as core } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Permission } from '@/server/access/types';
import type { Sql } from '@/server/platform/db';
import { assignRows } from './assign';
import {
  DISTRIBUTION_LOCK_KEY,
  type AssignLogKind,
  type AssignWritten,
  type DistributionActor,
  type WriteAssignBatch,
} from './types';

/** Начало транзакции раздачи: потолок ожидания 10 с и сериализация лимита. Первая команда транзакции. */
export async function lockDistribution(tx: Sql): Promise<void> {
  await tx`SET LOCAL lock_timeout = '10s'`;
  await tx`SELECT pg_advisory_xact_lock(${DISTRIBUTION_LOCK_KEY})`;
}

// ---------------------------------------------------------------------------
// Участники и нагрузка (§5.1, §5.2)
// ---------------------------------------------------------------------------

export interface ParticipantRow {
  userId: string;
  name: string;
  inDistribution: boolean;
  pausedOn: string;
  /** Последний день отсутствия, покрывающего сегодня; null — не отсутствует. */
  absentUntil: string | null;
}

export async function listParticipantRows(sql: Sql, a: { spaceId: string; roles: readonly string[]; today: string }): Promise<ParticipantRow[]> {
  return sql<ParticipantRow>`
    SELECT m.user_id, u.name, m.in_distribution, m.paused_on,
           (SELECT max(ab.to_day) FROM absences ab
             WHERE ab.space_id = m.space_id AND ab.user_id = m.user_id AND ab.cancelled_at IS NULL
               AND ${a.today}::text BETWEEN ab.from_day AND ab.to_day) AS absent_until
      FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND m.role_key = ANY(${[...a.roles]}::text[])
     ORDER BY u.name, m.user_id`;
}

export interface LoadRow {
  open: number;
  openNew: number;
  issuedToday: Partial<Record<core.IssueKind, number>>;
}

const CAP_KINDS: readonly string[] = ['auto', 'manual', 'return', 'inbound', 'proposal'];

/** «Открытые» и «выдано сегодня» по сотрудникам (временный владелец считается владельцем карточки). */
export async function loadParticipantLoad(sql: Sql, a: { spaceId: string; userIds: readonly string[]; now: number; today: string }): Promise<Map<string, LoadRow>> {
  const out = new Map<string, LoadRow>(a.userIds.map((u) => [u, { open: 0, openNew: 0, issuedToday: {} }]));
  if (a.userIds.length === 0) return out;
  const users = [...a.userIds];
  const open = await sql<{ userId: string; open: number; openNew: number }>`
    SELECT COALESCE(c.acting_user_id, c.owner_user_id) AS user_id,
           (count(*) FILTER (WHERE c.state = 'new'))::int AS open_new,
           (count(*) FILTER (WHERE c.state = 'new' OR c.next_call_at <= ${a.now}::bigint))::int AS open
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.hold_reason = '' AND c.state IN ('new','retry','callback')
       AND (c.owner_user_id = ANY(${users}::text[]) OR c.acting_user_id = ANY(${users}::text[]))
     GROUP BY 1`;
  for (const r of open) {
    const row = out.get(r.userId);
    if (row) {
      row.open = r.open;
      row.openNew = r.openNew;
    }
  }
  const issued = await sql<{ toUserId: string; kind: string; n: number }>`
    SELECT to_user_id, kind, count(*)::int AS n FROM assign_log
     WHERE space_id = ${a.spaceId} AND day = ${a.today}::text AND to_user_id = ANY(${users}::text[]) GROUP BY 1, 2`;
  for (const r of issued) {
    if (!CAP_KINDS.includes(r.kind)) continue;
    const row = out.get(r.toUserId);
    if (row) row.issuedToday[r.kind as core.IssueKind] = r.n;
  }
  return out;
}

/** Включить или выключить участие. null — не участник пространства (нет активного членства с такой ролью). */
export async function updateInDistribution(
  sql: Sql,
  a: { spaceId: string; userId: string; roles: readonly string[]; inDistribution: boolean; now: number },
): Promise<boolean> {
  const rows = await sql<{ userId: string }>`
    UPDATE memberships SET in_distribution = ${a.inDistribution}, updated_at = ${a.now}
     WHERE space_id = ${a.spaceId} AND user_id = ${a.userId} AND status = 'active' AND role_key = ANY(${[...a.roles]}::text[])
     RETURNING user_id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Пул, пары и двойники (§4, §5.3, §5.4)
// ---------------------------------------------------------------------------

export interface PoolRow {
  id: string;
  clientId: string;
  version: number;
  createdAt: number;
  hasMobile: boolean;
}

/** Готовые к раздаче карточки: без владельца, `new`, без задержки; порядок (created_at, id). */
export async function selectPoolCandidates(
  actor: DistributionActor,
  sql: Sql,
  a: { spaceId: string; limit: number; perm: Permission; after?: { createdAt: number; id: string } },
): Promise<PoolRow[]> {
  const after = a.after ?? { createdAt: -1, id: '' };
  return scoped(sql)<PoolRow>`
    SELECT c.id, c.client_id, c.version, c.created_at,
           EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.client_id AND p.is_working AND p.kind = 'mobile') AS has_mobile
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
       AND (c.created_at, c.id) > (${after.createdAt}::bigint, ${after.id}::text)
       AND ${scopeSql(actor, 'card', a.perm)}
     ORDER BY c.created_at, c.id LIMIT ${a.limit}`;
}

/** Из перечисленных карточек — те, что сейчас в пуле и видны по `perm`. */
export async function selectPoolCardsByIds(actor: DistributionActor, sql: Sql, a: { spaceId: string; ids: readonly string[]; perm: Permission }): Promise<PoolRow[]> {
  if (a.ids.length === 0) return [];
  return scoped(sql)<PoolRow>`
    SELECT c.id, c.client_id, c.version, c.created_at,
           EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.client_id AND p.is_working AND p.kind = 'mobile') AS has_mobile
      FROM cards c
     WHERE c.id = ANY(${[...a.ids]}::text[]) AND c.space_id = ${a.spaceId}
       AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
       AND ${scopeSql(actor, 'card', a.perm)}
     ORDER BY c.created_at, c.id`;
}

/** Двойники из пула по клиентам (без охвата: группа выдаётся целиком, D-038). */
export async function selectReadyCardsOfClients(sql: Sql, a: { spaceId: string; clientIds: readonly string[] }): Promise<PoolRow[]> {
  if (a.clientIds.length === 0) return [];
  return sql<PoolRow>`
    SELECT c.id, c.client_id, c.version, c.created_at,
           EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.client_id AND p.is_working AND p.kind = 'mobile') AS has_mobile
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.client_id = ANY(${[...a.clientIds]}::text[])
       AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
     ORDER BY c.created_at, c.id`;
}

export interface PairRow {
  aClientId: string;
  bClientId: string;
  status: 'open' | 'distinct';
}

export async function selectPairs(sql: Sql, clientIds: readonly string[]): Promise<PairRow[]> {
  if (clientIds.length === 0) return [];
  const ids = [...clientIds];
  return sql<PairRow>`
    SELECT p.a_client_id, p.b_client_id, p.status FROM dup_pairs p
     WHERE p.status IN ('open','distinct') AND (p.a_client_id = ANY(${ids}::text[]) OR p.b_client_id = ANY(${ids}::text[]))`;
}

export interface PartnerCardRow {
  id: string;
  clientId: string;
  ownerUserId: string | null;
  state: string;
  holdReason: string;
}

export async function selectCardsOfClients(sql: Sql, a: { spaceId: string; clientIds: readonly string[] }): Promise<PartnerCardRow[]> {
  if (a.clientIds.length === 0) return [];
  return sql<PartnerCardRow>`
    SELECT id, client_id, owner_user_id, state, hold_reason FROM cards
     WHERE space_id = ${a.spaceId} AND client_id = ANY(${[...a.clientIds]}::text[]) ORDER BY id`;
}

/** Сводка пула: задержанные без владельца по причине (§5.4) и число готовых. */
export async function poolCounts(actor: DistributionActor, sql: Sql, a: { spaceId: string }): Promise<{ ready: number; held: Record<string, number> }> {
  const rows = await scoped(sql)<{ holdReason: string; n: number }>`
    SELECT c.hold_reason, count(*)::int AS n FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NULL AND c.state = 'new'
       AND ${scopeSql(actor, 'card', 'pool.read')}
     GROUP BY 1`;
  const held: Record<string, number> = {};
  let ready = 0;
  for (const r of rows) {
    if (r.holdReason === '') ready = r.n;
    else held[r.holdReason] = r.n;
  }
  return { ready, held };
}

/** Страница пула с названиями клиентов (РОП с `pool.read` видит их по охвату space). */
export async function selectPoolPage(
  actor: DistributionActor,
  sql: Sql,
  a: { spaceId: string; limit: number; after: { createdAt: number; id: string } | null },
): Promise<(PoolRow & { name: string })[]> {
  const after = a.after ?? { createdAt: -1, id: '' };
  return scoped(sql)<PoolRow & { name: string }>`
    SELECT c.id, c.client_id, c.version, c.created_at, cl.name,
           EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.client_id AND p.is_working AND p.kind = 'mobile') AS has_mobile
      FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
       AND (c.created_at, c.id) > (${after.createdAt}::bigint, ${after.id}::text)
       AND ${scopeSql(actor, 'card', 'pool.read')}
     ORDER BY c.created_at, c.id LIMIT ${a.limit}`;
}

// ---------------------------------------------------------------------------
// Журнал и идемпотентность
// ---------------------------------------------------------------------------

/** Прогон тика уже записан (сбой воркера после коммита): повтор ничего не выдаёт. */
export async function runApplied(sql: Sql, a: { spaceId: string; day: string; runId: string }): Promise<boolean> {
  const rows = await sql<{ hit: number }>`
    SELECT 1 AS hit FROM assign_log WHERE space_id = ${a.spaceId} AND day = ${a.day}::text AND run_id = ${a.runId} LIMIT 1`;
  return rows.length > 0;
}

/** Выдачи ручной операции (повтор того же opId): карточки получателя. */
export async function selectOperationCards(sql: Sql, a: { spaceId: string; opId: string; days: readonly string[] }): Promise<{ cardId: string; toUserId: string | null }[]> {
  return sql<{ cardId: string; toUserId: string | null }>`
    SELECT card_id, to_user_id FROM assign_log
     WHERE space_id = ${a.spaceId} AND run_id = ${a.opId} AND kind = 'manual' AND day = ANY(${[...a.days]}::text[])
     ORDER BY created_at, card_id`;
}

export interface JournalDbRow {
  day: string;
  firstAt: number;
  kind: AssignLogKind;
  runId: string | null;
  fromUserId: string | null;
  toUserId: string | null;
  actorId: string | null;
  count: number;
  countsToCap: number;
}

export async function selectJournal(sql: Sql, a: { spaceId: string; from: string; to: string; userId: string | null }): Promise<JournalDbRow[]> {
  return sql<JournalDbRow>`
    SELECT a.day, min(a.created_at) AS first_at, a.kind, a.run_id, a.from_user_id, a.to_user_id, a.actor_id,
           count(*)::int AS count, (count(*) FILTER (WHERE a.counts_to_cap))::int AS counts_to_cap
      FROM assign_log a
     WHERE a.space_id = ${a.spaceId} AND a.day BETWEEN ${a.from}::text AND ${a.to}::text
       AND (${a.userId}::text IS NULL OR a.to_user_id = ${a.userId}::text OR a.from_user_id = ${a.userId}::text)
     GROUP BY a.day, a.kind, a.run_id, a.from_user_id, a.to_user_id, a.actor_id
     ORDER BY min(a.created_at) DESC, a.run_id
     LIMIT 500`;
}

export async function selectUserNames(sql: Sql, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; name: string }>`SELECT id, name FROM users WHERE id = ANY(${[...ids]}::text[])`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Запись выдачи пакетом (§3.3)
// ---------------------------------------------------------------------------

/** Компоненты связности карточек пакета по парам клиентов: группа двойников уходит целиком или никак. */
function groupsOf(cardClients: ReadonlyMap<string, string>, pairs: readonly PairRow[]): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
    return r;
  };
  for (const client of cardClients.values()) parent.set(client, client);
  for (const p of pairs) {
    if (!parent.has(p.aClientId) || !parent.has(p.bClientId)) continue;
    parent.set(find(p.aClientId), find(p.bClientId));
  }
  const groups = new Map<string, string[]>();
  for (const [card, client] of cardClients) {
    const g = find(client);
    const list = groups.get(g);
    if (list) list.push(card);
    else groups.set(g, [card]);
  }
  return groups;
}

export const writeAssignBatch: WriteAssignBatch = async (tx, actor, batch) => {
  const wanted = Object.values(batch.byOperator).flat();
  if (wanted.length === 0) return { byOperator: {}, raced: [] };
  const ownerOf = new Map<string, string>();
  for (const [userId, ids] of Object.entries(batch.byOperator)) for (const id of ids) ownerOf.set(id, userId);

  // 1. Клиенты карточек и группы двойников пакета (чтение без блокировок).
  const base = await tx<{ id: string; clientId: string }>`
    SELECT id, client_id FROM cards WHERE id = ANY(${wanted}::text[]) AND space_id = ${batch.spaceId}`;
  const clientOf = new Map(base.map((r) => [r.id, r.clientId]));
  const clients = [...new Set(clientOf.values())];
  const pairs = clients.length > 1 ? await selectPairs(tx, clients) : [];
  const groups = groupsOf(clientOf, pairs);

  // 2. Блокировка в порядке id; занятые чужой транзакцией и ушедшие из пула пропускаем.
  const locked = await scoped(tx)<{ id: string }>`
    SELECT c.id FROM cards c
     WHERE c.id = ANY(${wanted}::text[]) AND c.space_id = ${batch.spaceId}
       AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
       AND ${scopeSql(actor, 'card', 'card.assign')}
     ORDER BY c.id FOR UPDATE OF c SKIP LOCKED`;
  const lockedSet = new Set(locked.map((r) => r.id));
  // Группа двойников: хоть один не взят — выпадает вся группа (пару не делим, D-038).
  const dropped = new Set<string>();
  for (const members of groups.values()) {
    if (members.some((id) => !lockedSet.has(id))) for (const id of members) dropped.add(id);
  }
  const take = locked.map((r) => r.id).filter((id) => !dropped.has(id));
  if (take.length === 0) return { byOperator: {}, raced: wanted };

  // 3. Условное обновление владельца: версия + 1, `touched_in_crm` не трогаем (D-145).
  const owners = take.map((id) => ownerOf.get(id) as string);
  const updated = await tx<{ id: string }>`
    UPDATE cards c SET owner_user_id = w.owner, assigned_at = ${batch.now}::bigint, version = c.version + 1, updated_at = ${batch.now}::bigint
      FROM unnest(${take}::text[], ${owners}::text[]) AS w(id, owner)
     WHERE c.id = w.id AND c.space_id = ${batch.spaceId} AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
     RETURNING c.id`;
  const done = new Set(updated.map((r) => r.id));
  const byOperator: Record<string, string[]> = {};
  // Порядок выдачи плана сохраняем.
  for (const [userId, ids] of Object.entries(batch.byOperator)) {
    const ok = ids.filter((id) => done.has(id));
    if (ok.length > 0) byOperator[userId] = ok;
  }
  const raced = wanted.filter((id) => !done.has(id));
  if (done.size === 0) return { byOperator, raced };

  // 4. Журнал, лента, уведомления — строками, которые строит assignRows.
  const rows = assignRows(batch, byOperator, clientOf);
  await tx`
    INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
    SELECT w.id, ${batch.spaceId}::text, w.card_id, NULL, w.to_user_id, ${batch.kind}::text, ${batch.countsToCap}::boolean,
           ${batch.runId}::text, ${batch.day}::text, ${batch.actorId}::text, ${batch.now}::bigint
      FROM unnest(${rows.log.map((r) => r.id)}::text[], ${rows.log.map((r) => r.cardId)}::text[], ${rows.log.map((r) => r.toUserId)}::text[])
           AS w(id, card_id, to_user_id)`;
  await tx`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    SELECT w.id, w.client_id, ${batch.spaceId}::text, NULL, 'card.assigned', ${batch.actorId}::text, ${batch.now}::bigint, '', '',
           jsonb_build_object('toUserId', w.to_user_id, 'mode', ${batch.kind}::text)
      FROM unnest(${rows.events.map((r) => r.id)}::text[], ${rows.events.map((r) => r.clientId)}::text[], ${rows.events.map((r) => r.data.toUserId)}::text[])
           AS w(id, client_id, to_user_id)`;
  await tx`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    SELECT w.id, w.user_id, 'cards_assigned', '', '', jsonb_build_object('count', w.n), w.dedupe_key, ${batch.now}::bigint, ${batch.now}::bigint
      FROM unnest(${rows.notifications.map((r) => r.id)}::text[], ${rows.notifications.map((r) => r.userId)}::text[],
                  ${rows.notifications.map((r) => r.count)}::int[], ${rows.notifications.map((r) => r.dedupeKey)}::text[])
           AS w(id, user_id, n, dedupe_key)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  const written: AssignWritten = { byOperator, raced };
  return written;
};
