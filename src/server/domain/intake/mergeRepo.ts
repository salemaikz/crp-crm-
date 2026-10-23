// SQL слияния клиентов (docs/tasks-team-design.md §7.3, D-257). Строки карточек выбираются с охватом
// `client.merge`; клиенты, номера и ссылочные таблицы — по id клиентов пары, которую зритель уже увидел по охвату
// (служебные чтения слияния: наружу уходят только счётчики, id и отпечаток). Порядок блокировок (§1.2):
// INTAKE → DISTRIBUTION → клиенты по id → карточки по id → записи (эффекты) → пара и прочее.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Permission } from '@/server/access/types';
import type { Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import { DISTRIBUTION_LOCK_KEY, INTAKE_LOCK_KEY } from '@/server/platform/db/locks';
import type { ClientFill, MergeBookingRow, MergeClientRow, MoveClientTable } from './mergePlan';

/** Первая команда транзакции слияния: потолок ожидания и обе общие блокировки (приём, затем раздача). */
export async function lockMergeKeys(tx: Sql): Promise<void> {
  await tx`SET LOCAL lock_timeout = '10s'`;
  await tx`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
  await tx`SELECT pg_advisory_xact_lock(${DISTRIBUTION_LOCK_KEY})`;
}

// ---------------------------------------------------------------------------
// Пара
// ---------------------------------------------------------------------------

export interface PairRow {
  id: string;
  aClientId: string;
  bClientId: string;
  reason: 'shared_phone' | 'name_and_head';
  status: 'open' | 'merged' | 'distinct' | 'split_allowed';
}

export async function selectPairRow(sql: Sql, id: string, lock = false): Promise<PairRow | null> {
  const rows = lock
    ? await sql<PairRow>`SELECT id, a_client_id, b_client_id, reason, status FROM dup_pairs WHERE id = ${id} FOR UPDATE`
    : await sql<PairRow>`SELECT id, a_client_id, b_client_id, reason, status FROM dup_pairs WHERE id = ${id}`;
  return rows[0] ?? null;
}

/** Пара видна, если зрителю видна по разрешению хотя бы одна карточка стороны (чужое = несуществующее). */
export async function pairVisible(sql: Sql, viewer: Viewer, pair: Pick<PairRow, 'aClientId' | 'bClientId'>, perm: Permission): Promise<boolean> {
  const rows = await scoped(sql)<{ hit: number }>`
    SELECT 1 AS hit FROM cards c
     WHERE c.client_id IN (${pair.aClientId}, ${pair.bClientId}) AND ${scopeSql(viewer, 'card', perm)}
     LIMIT 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Клиенты и карточки
// ---------------------------------------------------------------------------

export async function selectMergeClients(sql: Sql, ids: readonly string[], lock: boolean): Promise<MergeClientRow[]> {
  const list = [...ids];
  return lock
    ? sql<MergeClientRow>`
        SELECT id, kind, name, legal_form, org_id, iin_hmac, region, address, email, website, custom, merged_into_id, updated_at
          FROM clients WHERE id = ANY(${list}::text[]) ORDER BY id FOR UPDATE`
    : sql<MergeClientRow>`
        SELECT id, kind, name, legal_form, org_id, iin_hmac, region, address, email, website, custom, merged_into_id, updated_at
          FROM clients WHERE id = ANY(${list}::text[]) ORDER BY id`;
}

/** Карточки обоих клиентов: видимые по `client.merge` (по id) и сколько их всего (во всех пространствах). */
export async function selectMergeCardIds(sql: Sql, viewer: Viewer, clientIds: readonly string[]): Promise<{ visible: string[]; total: number }> {
  const list = [...clientIds];
  const visible = await scoped(sql)<{ id: string }>`
    SELECT c.id FROM cards c WHERE c.client_id = ANY(${list}::text[]) AND ${scopeSql(viewer, 'card', 'client.merge')} ORDER BY c.id`;
  const [all] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM cards WHERE client_id = ANY(${list}::text[])`;
  return { visible: visible.map((r) => r.id), total: all?.n ?? 0 };
}

export async function selectPhones(sql: Sql, clientId: string): Promise<Array<{ id: string; digits: string }>> {
  return sql<{ id: string; digits: string }>`SELECT id, digits FROM client_phones WHERE client_id = ${clientId} ORDER BY created_at, id`;
}

/** Записи обоих клиентов, которые могут помешать слиянию: живые групповые и будущие активные. */
export async function selectMergeBookings(sql: Sql, clientIds: readonly string[], now: number): Promise<MergeBookingRow[]> {
  return sql<MergeBookingRow>`
    SELECT id, client_id, kind, event_id, event_type_key, status, starts_at FROM bookings
     WHERE client_id = ANY(${[...clientIds]}::text[])
       AND ((kind = 'group' AND status IN ('registered','confirmed','attended','no_show'))
         OR (status IN ('registered','confirmed') AND starts_at > ${now}::bigint))
     ORDER BY id`;
}

/** id строк проигравшего, которые переедут (для счётчиков и отпечатка). */
export async function selectMoveIds(sql: Sql, loserId: string): Promise<Record<MoveClientTable | 'proposals', string[]>> {
  const ids = async (q: Promise<Array<{ id: string }>>) => (await q).map((r) => r.id);
  return {
    contacts: await ids(sql`SELECT id FROM contacts WHERE client_id = ${loserId} ORDER BY id`),
    client_sources: await ids(sql`SELECT id FROM client_sources WHERE client_id = ${loserId} ORDER BY id`),
    import_rows: await ids(sql`SELECT id FROM import_rows WHERE client_id = ${loserId} ORDER BY id`),
    messenger_chats: await ids(sql`SELECT id FROM messenger_chats WHERE client_id = ${loserId} ORDER BY id`),
    handoffs: await ids(sql`SELECT id FROM handoffs WHERE client_id = ${loserId} ORDER BY id`),
    notes: await ids(sql`SELECT id FROM notes WHERE client_id = ${loserId} ORDER BY id`),
    tasks: await ids(sql`SELECT id FROM tasks WHERE client_id = ${loserId} ORDER BY id`),
    deals: await ids(sql`SELECT id FROM deals WHERE client_id = ${loserId} ORDER BY id`),
    bookings: await ids(sql`SELECT id FROM bookings WHERE client_id = ${loserId} ORDER BY id`),
    calls: await ids(sql`SELECT id FROM calls WHERE client_id = ${loserId} ORDER BY id`),
    proposals: await ids(sql`SELECT id FROM proposals WHERE client_id = ${loserId} OR matched_client_id = ${loserId} ORDER BY id`),
  };
}

export async function selectUserNames(sql: Sql, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; name: string }>`SELECT id, name FROM users WHERE id = ANY(${[...ids]}::text[])`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Повтор
// ---------------------------------------------------------------------------

export interface PriorMerge {
  pairId: string;
  survivorId: string;
  loserId: string;
  counts: Record<string, number>;
}

/** Прежнее слияние с тем же opId: снимки операции есть и проигравший уже слит в выжившего (аудит хранит ответ). */
export async function selectPriorMerge(sql: Sql, opId: string): Promise<PriorMerge | null> {
  const rows = await sql<{ meta: { pairId?: string; survivorId?: string; loserId?: string; counts?: Record<string, number> } }>`
    SELECT a.meta FROM audit_log a
     WHERE a.action = 'client.merge' AND a.meta->>'opId' = ${opId}
       AND EXISTS (SELECT 1 FROM change_snapshots s WHERE s.operation_id = ${opId} AND s.kind = 'merge')
       AND EXISTS (SELECT 1 FROM clients l WHERE l.id = a.meta->>'loserId' AND l.merged_into_id = a.meta->>'survivorId')
     LIMIT 1`;
  const m = rows[0]?.meta;
  if (!m?.pairId || !m.survivorId || !m.loserId) return null;
  return { pairId: m.pairId, survivorId: m.survivorId, loserId: m.loserId, counts: m.counts ?? {} };
}

/** opId уже занят другой операцией (снимками). */
export async function opIdTaken(sql: Sql, opId: string): Promise<boolean> {
  const rows = await sql<{ hit: number }>`SELECT 1 AS hit FROM change_snapshots WHERE operation_id = ${opId} LIMIT 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Снимок «до» (D-062)
// ---------------------------------------------------------------------------

/**
 * Каждая строка, которую слияние изменит или удалит: оба клиента, все карточки обоих, номера и ссылочные строки
 * проигравшего, открытые задачи и сделки и будущие активные записи выжившего (их переназначают эффекты ядра),
 * пары проигравшего. Пишется одной командой до первой правки.
 */
export async function writeMergeSnapshots(
  tx: Sql,
  a: { opId: string; actorId: string; now: number; survivorId: string; loserId: string; cardIds: readonly string[] },
): Promise<number> {
  const { survivorId: s, loserId: l, now } = a;
  const rows = await tx<{ id: string }>`
    INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
    SELECT gen_random_uuid()::text, ${a.opId}, 'merge', u.t, u.id, u.c, u.b, ${a.actorId}, ${now}::bigint FROM (
      SELECT 'clients' AS t, x.id, x.id AS c, to_jsonb(x) AS b FROM clients x WHERE x.id IN (${s}, ${l})
      UNION ALL SELECT 'cards', x.id, x.client_id, to_jsonb(x) FROM cards x WHERE x.id = ANY(${[...a.cardIds]}::text[])
      UNION ALL SELECT 'client_phones', x.id, x.client_id, to_jsonb(x) FROM client_phones x WHERE x.client_id = ${l}
      UNION ALL SELECT 'contacts', x.id, x.client_id, to_jsonb(x) FROM contacts x WHERE x.client_id = ${l}
      UNION ALL SELECT 'client_sources', x.id, x.client_id, to_jsonb(x) FROM client_sources x WHERE x.client_id = ${l}
      UNION ALL SELECT 'import_rows', x.id, x.client_id, to_jsonb(x) FROM import_rows x WHERE x.client_id = ${l}
      UNION ALL SELECT 'messenger_chats', x.id, x.client_id, to_jsonb(x) FROM messenger_chats x WHERE x.client_id = ${l}
      UNION ALL SELECT 'handoffs', x.id, x.client_id, to_jsonb(x) FROM handoffs x WHERE x.client_id = ${l}
      UNION ALL SELECT 'notes', x.id, x.client_id, to_jsonb(x) FROM notes x WHERE x.client_id = ${l}
      UNION ALL SELECT 'calls', x.id, x.client_id, to_jsonb(x) FROM calls x WHERE x.client_id = ${l}
      UNION ALL SELECT 'proposals', x.id, ${l}::text, to_jsonb(x) FROM proposals x WHERE x.client_id = ${l} OR x.matched_client_id = ${l}
      UNION ALL SELECT 'tasks', x.id, x.client_id, to_jsonb(x) FROM tasks x
                 WHERE x.client_id = ${l} OR (x.client_id = ${s} AND x.status = 'open')
      UNION ALL SELECT 'deals', x.id, x.client_id, to_jsonb(x) FROM deals x
                 WHERE x.client_id = ${l} OR (x.client_id = ${s} AND x.status = 'open')
      UNION ALL SELECT 'bookings', x.id, x.client_id, to_jsonb(x) FROM bookings x
                 WHERE x.client_id = ${l} OR (x.client_id = ${s} AND x.status IN ('registered','confirmed') AND x.starts_at > ${now}::bigint)
      UNION ALL SELECT 'dup_pairs', x.id, ${l}::text, to_jsonb(x) FROM dup_pairs x WHERE x.a_client_id = ${l} OR x.b_client_id = ${l}
    ) u
    RETURNING id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Перенос
// ---------------------------------------------------------------------------

/** Шаг 1: дубли цифр удаляются, остальные номера переходят выжившему не основными. */
export async function moveLoserPhones(tx: Sql, a: { loserId: string; survivorId: string; move: readonly string[]; drop: readonly string[] }): Promise<void> {
  if (a.drop.length > 0) await tx`DELETE FROM client_phones WHERE client_id = ${a.loserId} AND id = ANY(${[...a.drop]}::text[])`;
  if (a.move.length > 0) {
    await tx`UPDATE client_phones SET client_id = ${a.survivorId}, is_primary = FALSE WHERE client_id = ${a.loserId} AND id = ANY(${[...a.move]}::text[])`;
  }
}

/** Шаг 2: `client_id` проигравшего → выживший во всех таблицах переноса. Возвращает число строк по таблицам. */
export async function moveLoserRows(tx: Sql, a: { loserId: string; survivorId: string; now: number }): Promise<Record<MoveClientTable | 'proposals', number>> {
  const { loserId: l, survivorId: s, now } = a;
  const n = async (q: Promise<Array<{ id: string }>>) => (await q).length;
  return {
    contacts: await n(tx`UPDATE contacts SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    client_sources: await n(tx`UPDATE client_sources SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    import_rows: await n(tx`UPDATE import_rows SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    messenger_chats: await n(tx`UPDATE messenger_chats SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    handoffs: await n(tx`UPDATE handoffs SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    notes: await n(tx`UPDATE notes SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    tasks: await n(tx`UPDATE tasks SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    deals: await n(tx`UPDATE deals SET client_id = ${s}, updated_at = ${now} WHERE client_id = ${l} RETURNING id`),
    bookings: await n(tx`UPDATE bookings SET client_id = ${s}, updated_at = ${now} WHERE client_id = ${l} RETURNING id`),
    calls: await n(tx`UPDATE calls SET client_id = ${s} WHERE client_id = ${l} RETURNING id`),
    proposals: await n(tx`
      UPDATE proposals SET client_id = CASE WHEN client_id = ${l} THEN ${s} ELSE client_id END,
                           matched_client_id = CASE WHEN matched_client_id = ${l} THEN ${s} ELSE matched_client_id END
       WHERE client_id = ${l} OR matched_client_id = ${l} RETURNING id`),
  };
}

/** Шаг 3: звонки, сделки и записи проигравшей карточки → выжившая карточка того же пространства. */
export async function moveCardRefs(tx: Sql, a: { fromCardId: string; toCardId: string; now: number }): Promise<void> {
  await tx`UPDATE calls SET card_id = ${a.toCardId} WHERE card_id = ${a.fromCardId}`;
  await tx`UPDATE deals SET card_id = ${a.toCardId}, updated_at = ${a.now} WHERE card_id = ${a.fromCardId}`;
  await tx`UPDATE bookings SET card_id = ${a.toCardId}, updated_at = ${a.now} WHERE card_id = ${a.fromCardId}`;
}

/** Проигравшая карточка остаётся строкой (на неё ссылаются журналы): без владельца, с задержкой `merged` (D-257). */
export async function retireLoserCard(tx: Sql, a: { cardId: string; now: number }): Promise<void> {
  await tx`
    UPDATE cards SET owner_user_id = NULL, acting_user_id = NULL, acting_until_day = '', next_call_at = NULL,
                     hold_reason = 'merged', callback_reason = '', callback_touches = 0,
                     version = version + 1, updated_at = ${a.now}
     WHERE id = ${a.cardId}`;
}

/** Карточка есть только у проигравшего: переходит выжившему целиком. */
export async function moveLoserCard(tx: Sql, a: { cardId: string; survivorId: string; now: number }): Promise<void> {
  await tx`UPDATE cards SET client_id = ${a.survivorId}, version = version + 1, updated_at = ${a.now} WHERE id = ${a.cardId}`;
}

/** Шаг 4: проигравший слит (первым: частичные уникальные индексы БИН и ИИН перестают его учитывать). */
export async function markLoserMerged(tx: Sql, a: { loserId: string; survivorId: string; now: number }): Promise<void> {
  await tx`UPDATE clients SET merged_into_id = ${a.survivorId}, updated_at = ${a.now} WHERE id = ${a.loserId}`;
}

/** Шаг 5: поля выжившего (пустые уже заполнены планом) и строка поиска. */
export async function writeSurvivorFields(tx: Sql, a: { survivorId: string; fill: ClientFill; searchNorm: string; now: number }): Promise<void> {
  const f = a.fill;
  await tx`
    UPDATE clients SET legal_form = ${f.legalForm}, org_id = ${f.orgId}, iin_hmac = ${f.iinHmac}, region = ${f.region},
                       address = ${f.address}, email = ${f.email}, website = ${f.website}, custom = ${jsonParam(f.custom)},
                       search_norm = ${a.searchNorm}, updated_at = ${a.now}
     WHERE id = ${a.survivorId}`;
}

export async function selectAllDigits(tx: Sql, clientId: string): Promise<string[]> {
  const rows = await tx<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = ${clientId} ORDER BY created_at, id`;
  return rows.map((r) => r.digits);
}

/**
 * Шаг 6: эта пара и пары (проигравший, выживший) по другой причине → `merged`; прочие пары проигравшего с X ≠
 * выживший повторяются парой (X, выживший) с тем же статусом и комментарием (ON CONFLICT DO NOTHING), старые → `merged`.
 */
export async function repointPairs(tx: Sql, a: { pairId: string; loserId: string; survivorId: string; by: string; now: number }): Promise<void> {
  const { loserId: l, survivorId: s } = a;
  await tx`
    UPDATE dup_pairs SET status = 'merged', resolved_by = ${a.by}, resolved_at = ${a.now}
     WHERE id = ${a.pairId} OR (a_client_id = LEAST(${l}::text, ${s}::text) AND b_client_id = GREATEST(${l}::text, ${s}::text) AND status <> 'merged')`;
  await tx`
    INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, comment, resolved_by, resolved_at, created_at)
    SELECT gen_random_uuid()::text, LEAST(x.other, ${s}::text), GREATEST(x.other, ${s}::text), x.reason, x.status, x.comment,
           x.resolved_by, x.resolved_at, x.created_at
      FROM (SELECT p.*, CASE WHEN p.a_client_id = ${l} THEN p.b_client_id ELSE p.a_client_id END AS other
              FROM dup_pairs p WHERE (p.a_client_id = ${l} OR p.b_client_id = ${l}) AND p.status <> 'merged') x
     WHERE x.other <> ${s}
    ON CONFLICT (a_client_id, b_client_id, reason) DO NOTHING`;
  await tx`
    UPDATE dup_pairs SET status = 'merged', resolved_by = COALESCE(resolved_by, ${a.by}), resolved_at = COALESCE(resolved_at, ${a.now})
     WHERE (a_client_id = ${l} OR b_client_id = ${l}) AND status <> 'merged'`;
}

/**
 * Снять задержку «Возможный дубль» у карточек клиентов, у которых не осталось открытых пар (D-272): после решения
 * РОП по паре или слияния карточка возвращается в «Готовы к раздаче», двойники — по правилам D-174.
 * Служебный запрос без охвата: вызывающий уже проверил видимость пары (решение) или право на все карточки сторон
 * (слияние, конфликт `other_space`). Пара общая для установки, поэтому задержка снимается и у стороны в чужом
 * отделе — иначе она осталась бы в «Возможный дубль» навсегда.
 */
export async function releaseDupPairHolds(tx: Sql, clientIds: readonly string[], now: number): Promise<number> {
  const rows = await tx<{ id: string }>`
    UPDATE cards c SET hold_reason = '', version = c.version + 1, updated_at = ${now}
     WHERE c.client_id = ANY(${[...clientIds]}::text[]) AND c.hold_reason = 'dup_pair'
       AND NOT EXISTS (SELECT 1 FROM dup_pairs p WHERE p.status = 'open' AND (p.a_client_id = c.client_id OR p.b_client_id = c.client_id))
     RETURNING c.id`;
  return rows.length;
}
