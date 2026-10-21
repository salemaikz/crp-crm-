// SQL приёма лидов (INTEGRATIONS §5). Единственное место с запросами модуля intake.
// Здесь нет scopeSql намеренно: приём работает не от лица сотрудника, а по ключу источника, и должен видеть всю базу
// клиентов (дедуп со всей базой, стоп-лист). Наружу репозиторий не выходит: его вызывают сервисы модуля, которым
// ключ уже дал `IngestPrincipal`. Журналы и отчёты — без ПДн.
import { dedup } from '@crm/core';
import { jsonParam, type Sql } from '@/server/platform/db/core';
import { INTAKE_LOCK_KEY } from '@/server/platform/db/locks';

const { HIDDEN_ORG_ID_PREFIX } = dedup;
import type { BatchReport, IngestScope } from './types';

// ---------- Ключи ----------

export interface KeyRow {
  id: string;
  prefix: string;
  keyHash: string;
  spaceId: string;
  spaceKey: string;
  sourceKey: string;
  scopes: IngestScope[];
  managed: 'ui' | 'cli';
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const KEY_SELECT = (sql: Sql, where: 'prefix' | 'all', prefix: string) =>
  where === 'prefix'
    ? sql<KeyRow>`
        SELECT k.id, k.prefix, k.key_hash, k.space_id, s.key AS space_key, k.source_key, k.scopes, k.managed,
               k.created_at, k.last_used_at, k.revoked_at
          FROM ingest_keys k JOIN spaces s ON s.id = k.space_id
         WHERE k.prefix = ${prefix}`
    : sql<KeyRow>`
        SELECT k.id, k.prefix, k.key_hash, k.space_id, s.key AS space_key, k.source_key, k.scopes, k.managed,
               k.created_at, k.last_used_at, k.revoked_at
          FROM ingest_keys k JOIN spaces s ON s.id = k.space_id
         ORDER BY k.created_at, k.prefix`;

export async function findKeyByPrefix(sql: Sql, prefix: string): Promise<KeyRow | null> {
  return (await KEY_SELECT(sql, 'prefix', prefix))[0] ?? null;
}

export async function listKeys(sql: Sql): Promise<KeyRow[]> {
  return KEY_SELECT(sql, 'all', '');
}

export async function spaceIdByKey(sql: Sql, key: string): Promise<string | null> {
  const [r] = await sql<{ id: string }>`SELECT id FROM spaces WHERE key = ${key}`;
  return r?.id ?? null;
}

export async function insertKey(
  sql: Sql,
  k: { id: string; prefix: string; keyHash: string; spaceId: string; sourceKey: string; scopes: readonly IngestScope[]; managed: 'ui' | 'cli'; now: number },
): Promise<void> {
  await sql`
    INSERT INTO ingest_keys (id, prefix, key_hash, space_id, source_key, scopes, managed, created_at)
    VALUES (${k.id}, ${k.prefix}, ${k.keyHash}, ${k.spaceId}, ${k.sourceKey}, ${[...k.scopes]}::text[], ${k.managed}, ${k.now})`;
}

/** Отозвать ключ; уже отозванный не трогаем. Возвращает id ключа или null, если активного ключа с таким prefix нет. */
export async function revokeKeyRow(sql: Sql, prefix: string, now: number): Promise<string | null> {
  const r = await sql<{ id: string }>`UPDATE ingest_keys SET revoked_at = ${now} WHERE prefix = ${prefix} AND revoked_at IS NULL RETURNING id`;
  return r[0]?.id ?? null;
}

/** `last_used_at` не чаще раза в минуту (INTEGRATIONS 5.1). */
export async function touchKey(sql: Sql, id: string, now: number): Promise<void> {
  await sql`UPDATE ingest_keys SET last_used_at = ${now} WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at <= ${now - 60_000})`;
}

// ---------- Партии ----------

/** Общая блокировка приёма: её берут все пути, создающие клиента (одна константа INTAKE_LOCK_KEY). */
export async function lockIntake(sql: Sql): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
}

/**
 * Блокировка приёма первой командой тх с ограничением ожидания (docs/tasks-team-design.md §1.2): `lock_timeout` 10 с
 * ставится до advisory-блокировки и действует до конца тх. Для интерактивных путей (предложение контакта, разбор РОП).
 */
export async function lockIntakeFirst(sql: Sql): Promise<void> {
  await sql`SET LOCAL lock_timeout = '10s'`;
  await lockIntake(sql);
}

export async function findBatch(sql: Sql, sourceKey: string, batchId: string): Promise<{ requestHash: string; report: BatchReport } | null> {
  const [r] = await sql<{ requestHash: string; report: BatchReport }>`
    SELECT request_hash, report FROM ingest_batches WHERE source_key = ${sourceKey} AND batch_id = ${batchId}`;
  return r ?? null;
}

export async function insertBatch(
  sql: Sql,
  b: { id: string; keyId: string; sourceKey: string; batchId: string; requestHash: string; report: BatchReport; now: number },
): Promise<void> {
  await sql`
    INSERT INTO ingest_batches (id, key_id, source_key, batch_id, request_hash, report, received_at)
    VALUES (${b.id}, ${b.keyId}, ${b.sourceKey}, ${b.batchId}, ${b.requestHash}, ${jsonParam(b.report)}, ${b.now})`;
}

// ---------- Чтение для дедупа ----------

/** Какие из HMAC номеров есть в стоп-листе. */
export async function stopListHits(sql: Sql, hashes: readonly string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await sql<{ phoneHmac: string }>`SELECT phone_hmac FROM stop_list WHERE phone_hmac = ANY(${[...hashes]}::text[])`;
  return new Set(rows.map((r) => r.phoneHmac));
}

/** externalId источника → итоговый клиент (цепочка слияний пройдена до конца). */
export async function clientsByExternalId(sql: Sql, sourceKey: string, externalIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (externalIds.length === 0) return out;
  const rows = await sql<{ externalId: string; id: string }>`
    WITH RECURSIVE chain AS (
      SELECT cs.external_id, c.id, c.merged_into_id, 0 AS depth
        FROM client_sources cs JOIN clients c ON c.id = cs.client_id
       WHERE cs.source_key = ${sourceKey} AND cs.external_id = ANY(${[...externalIds]}::text[])
      UNION ALL
      SELECT chain.external_id, c.id, c.merged_into_id, chain.depth + 1
        FROM chain JOIN clients c ON c.id = chain.merged_into_id
       WHERE chain.depth < 20
    )
    SELECT external_id, id FROM chain WHERE merged_into_id IS NULL`;
  for (const r of rows) out.set(r.externalId, r.id);
  return out;
}

/** Скрытый ключ номера в индексе дедупа: `iin:<HMAC>` (D-052, D-141). */
export const hiddenKey = (iinHmac: string): string => `${HIDDEN_ORG_ID_PREFIX}${iinHmac}`;

/**
 * Ключи номера клиента базы для индекса (D-141): открытый БИН — с псевдонимом `iin:<HMAC БИН>` (по нему
 * находится запись, скрытая «по неуверенности»), иначе — `iin:<HMAC>`. ИИН рядом с БИН (`iin_hmac` у ТОО)
 * псевдонимом не становится: это другой номер, его уникальность проверяет запись (`orgKeysTaken`).
 */
export function storedOrgKeys(
  c: { orgId: string; iinHmac: string | null },
  hmacOf: (digits: string) => string,
): Pick<dedup.CompanyKeys, 'orgId' | 'orgIdAliases'> {
  if (c.orgId) return { orgId: c.orgId, orgIdAliases: [hiddenKey(hmacOf(c.orgId))] };
  if (c.iinHmac) return { orgId: hiddenKey(c.iinHmac), orgIdAliases: [] };
  return { orgId: null, orgIdAliases: [] };
}

interface KnownRow {
  id: string;
  nameNorm: string;
  legalForm: string;
  orgId: string;
  iinHmac: string | null;
  createdAt: number;
  phones: string[];
  stubs: string[];
  head: string | null;
}

/**
 * Клиенты базы, у которых есть хоть один общий ключ с записями партии: БИН (`org_id`), HMAC ИИН
 * (`iin_hmac`, в том числе HMAC открытого БИН записи — так находится клиент, скрытый «по неуверенности»),
 * рабочий номер, название. Слитые и обезличенные не участвуют. Остальную базу в память не грузим.
 */
export async function loadKnownCompanies(
  sql: Sql,
  keys: { bins: readonly string[]; iinHmacs: readonly string[]; phones: readonly string[]; nameNorms: readonly string[] },
  normalizePerson: (s: string) => string,
  hmacOf: (digits: string) => string,
): Promise<dedup.KnownCompany[]> {
  const bins = [...new Set(keys.bins)];
  const iins = [...new Set(keys.iinHmacs)];
  const phones = [...new Set(keys.phones)];
  const nameNorms = [...new Set(keys.nameNorms)];
  if (bins.length + iins.length + phones.length + nameNorms.length === 0) return [];
  const rows = await sql<KnownRow>`
    SELECT c.id, c.name_norm, c.legal_form, c.org_id, c.iin_hmac, c.created_at,
           COALESCE(array_agg(p.digits) FILTER (WHERE p.is_working), '{}') AS phones,
           COALESCE(array_agg(p.digits) FILTER (WHERE NOT p.is_working), '{}') AS stubs,
           (SELECT ct.name FROM contacts ct WHERE ct.client_id = c.id AND ct.archived_at IS NULL
             ORDER BY ct.is_decision_maker DESC, ct.created_at, ct.id LIMIT 1) AS head
      FROM clients c LEFT JOIN client_phones p ON p.client_id = c.id
     WHERE c.merged_into_id IS NULL AND c.depersonalized_at IS NULL
       AND (
            (c.org_id <> '' AND c.org_id = ANY(${bins}::text[]))
         OR (c.iin_hmac IS NOT NULL AND c.iin_hmac = ANY(${iins}::text[]))
         OR c.id IN (SELECT cp.client_id FROM client_phones cp WHERE cp.digits = ANY(${phones}::text[]))
         OR (c.name_norm <> '' AND c.name_norm = ANY(${nameNorms}::text[]))
       )
     GROUP BY c.id`;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    ...storedOrgKeys(r, hmacOf),
    legalForm: r.legalForm,
    phones: r.phones,
    stubPhones: r.stubs,
    nameNorm: r.nameNorm,
    headNorm: r.head ? normalizePerson(r.head) : '',
  }));
}

/**
 * Заняты ли БИН и HMAC ИИН другим неслитым клиентом (уникальные clients_org_uq, clients_iin_uq). Вызывается под
 * INTAKE_LOCK_KEY: все пути, ставящие БИН или ИИН, берут её первой (D-126), поэтому ответ не устареет до записи.
 */
export async function orgKeysTaken(sql: Sql, orgId: string, iinHmac: string | null): Promise<{ org: boolean; iin: boolean }> {
  if (!orgId && !iinHmac) return { org: false, iin: false };
  const [r] = await sql<{ org: boolean; iin: boolean }>`
    SELECT COALESCE(bool_or(org_id <> '' AND org_id = ${orgId}), FALSE) AS org,
           COALESCE(bool_or(iin_hmac = ${iinHmac}::text), FALSE) AS iin
      FROM clients
     WHERE merged_into_id IS NULL AND ((${orgId} <> '' AND org_id = ${orgId}) OR iin_hmac = ${iinHmac}::text)`;
  return { org: r?.org ?? false, iin: r?.iin ?? false };
}

// ---------- Дописывание в существующего клиента ----------

export interface ClientForMerge {
  id: string;
  kind: 'company' | 'person';
  legalForm: string;
  region: string;
  address: string;
  email: string;
  website: string;
  orgId: string;
  iinHmac: string | null;
  custom: Record<string, unknown>;
  hasPrimaryPhone: boolean;
  phones: string[];
  contactCount: number;
  nameNorm: string;
  createdAt: number;
}

export async function clientForMerge(sql: Sql, id: string): Promise<ClientForMerge | null> {
  const [c] = await sql<Omit<ClientForMerge, 'hasPrimaryPhone' | 'phones' | 'contactCount'>>`
    SELECT id, kind, legal_form, region, address, email, website, org_id, iin_hmac, custom, name_norm, created_at
      FROM clients WHERE id = ${id}`;
  if (!c) return null;
  const phones = await sql<{ digits: string; isPrimary: boolean }>`SELECT digits, is_primary FROM client_phones WHERE client_id = ${id}`;
  const [n] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM contacts WHERE client_id = ${id} AND archived_at IS NULL`;
  return { ...c, phones: phones.map((p) => p.digits), hasPrimaryPhone: phones.some((p) => p.isPrimary), contactCount: n?.n ?? 0 };
}

export interface ClientPatch {
  region?: string;
  address?: string;
  email?: string;
  website?: string;
  orgId?: string;
  iinHmac?: string;
  custom?: Record<string, unknown>;
}

/**
 * Дописать пустые поля. БИН/ИИН ставятся, только если их ещё нет ни у кого другого (уникальные индексы).
 * Возвращает то, что после записи лежит в `org_id` и `iin_hmac`.
 */
export async function patchClient(sql: Sql, id: string, p: ClientPatch, now: number): Promise<{ orgId: string; iinHmac: string | null }> {
  const [r] = await sql<{ orgId: string; iinHmac: string | null }>`
    UPDATE clients SET
      region      = COALESCE(${p.region ?? null}, region),
      address     = COALESCE(${p.address ?? null}, address),
      email       = COALESCE(${p.email ?? null}, email),
      website     = COALESCE(${p.website ?? null}, website),
      org_id      = CASE WHEN ${p.orgId ?? null}::text IS NOT NULL AND org_id = ''
                          AND NOT EXISTS (SELECT 1 FROM clients o WHERE o.org_id = ${p.orgId ?? null}::text AND o.id <> clients.id AND o.merged_into_id IS NULL)
                         THEN ${p.orgId ?? null}::text ELSE org_id END,
      iin_hmac    = CASE WHEN ${p.iinHmac ?? null}::text IS NOT NULL AND iin_hmac IS NULL
                          AND NOT EXISTS (SELECT 1 FROM clients o WHERE o.iin_hmac = ${p.iinHmac ?? null}::text AND o.id <> clients.id AND o.merged_into_id IS NULL)
                         THEN ${p.iinHmac ?? null}::text ELSE iin_hmac END,
      custom      = COALESCE(${p.custom ? jsonParam(p.custom) : null}::jsonb, custom),
      updated_at  = ${now}
    WHERE id = ${id}
    RETURNING org_id, iin_hmac`;
  if (!r) throw new Error('клиент для дописывания не найден');
  return r;
}

/** Источник строки поиска клиента (D-123): название, БИН, значения полей и все номера. */
export async function searchSource(sql: Sql, id: string): Promise<{ name: string; orgId: string; custom: Record<string, unknown>; phones: string[] } | null> {
  const [c] = await sql<{ name: string; orgId: string; custom: Record<string, unknown> }>`SELECT name, org_id, custom FROM clients WHERE id = ${id}`;
  if (!c) return null;
  const phones = await sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = ${id} ORDER BY created_at, id`;
  return { ...c, phones: phones.map((p) => p.digits) };
}

export async function setSearchNorm(sql: Sql, id: string, searchNorm: string): Promise<void> {
  await sql`UPDATE clients SET search_norm = ${searchNorm} WHERE id = ${id}`;
}

export async function addPhones(
  sql: Sql,
  clientId: string,
  phones: readonly { id: string; digits: string; kind: string; ext: string; isPrimary: boolean }[],
  now: number,
): Promise<void> {
  for (const p of phones) {
    await sql`
      INSERT INTO client_phones (id, client_id, digits, ext, kind, is_working, is_primary, created_at)
      VALUES (${p.id}, ${clientId}, ${p.digits}, ${p.ext}, ${p.kind}, TRUE, ${p.isPrimary}, ${now})
      ON CONFLICT (client_id, digits) DO NOTHING`;
  }
}

export async function addContact(sql: Sql, id: string, clientId: string, name: string, now: number): Promise<void> {
  await sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES (${id}, ${clientId}, ${name}, ${now})`;
}

export async function addSource(
  sql: Sql,
  s: { id: string; clientId: string; sourceKey: string; keyId: string | null; externalId: string | null; now: number; sourceKind?: 'ingest' | 'messenger' },
): Promise<void> {
  await sql`
    INSERT INTO client_sources (id, client_id, source_kind, source_key, ingest_key_id, external_id, first_seen_at)
    VALUES (${s.id}, ${s.clientId}, ${s.sourceKind ?? 'ingest'}, ${s.sourceKey}, ${s.keyId}, ${s.externalId}, ${s.now})
    ON CONFLICT DO NOTHING`;
}

// ---------- Создание клиента и карточки ----------

export interface NewClient {
  id: string;
  kind: 'company' | 'person';
  name: string;
  nameNorm: string;
  legalForm: string;
  orgId: string;
  iinHmac: string | null;
  region: string;
  address: string;
  email: string;
  website: string;
  custom: Record<string, unknown>;
  searchNorm: string;
  sourceKey: string;
  /** Откуда клиент: по умолчанию приём по ключу; «Предложить контакт» — `proposal`; входящее из мессенджера — `messenger` (O7a). */
  sourceKind?: 'ingest' | 'proposal' | 'messenger';
  now: number;
}

export async function insertClient(sql: Sql, c: NewClient): Promise<void> {
  await sql`
    INSERT INTO clients (id, kind, name, name_norm, legal_form, org_id, iin_hmac, region, address, email, website, custom,
                         search_norm, source_kind, source_key, created_at, updated_at)
    VALUES (${c.id}, ${c.kind}, ${c.name}, ${c.nameNorm}, ${c.legalForm}, ${c.orgId}, ${c.iinHmac}, ${c.region}, ${c.address},
            ${c.email}, ${c.website}, ${jsonParam(c.custom)}, ${c.searchNorm}, ${c.sourceKind ?? 'ingest'}, ${c.sourceKey}, ${c.now}, ${c.now})`;
}

/** Карточка в пуле: без владельца, состояние «новая»; задержка — через `hold_reason`. */
export async function insertCard(
  sql: Sql,
  c: { id: string; spaceId: string; clientId: string; holdReason: '' | 'dup_pair' | 'rule'; holdCode: string; now: number },
): Promise<void> {
  await sql`
    INSERT INTO cards (id, space_id, client_id, state, hold_reason, hold_code, created_at, updated_at)
    VALUES (${c.id}, ${c.spaceId}, ${c.clientId}, 'new', ${c.holdReason}, ${c.holdCode}, ${c.now}, ${c.now})`;
}

/** Спорные пары: a < b, повтор не создаёт вторую строку. */
export async function insertPairs(
  sql: Sql,
  newClientId: string,
  pairs: readonly { id: string; reason: 'shared_phone' | 'name_and_head'; rowId: string }[],
  now: number,
): Promise<void> {
  for (const p of pairs) {
    const [a, b] = newClientId < p.id ? [newClientId, p.id] : [p.id, newClientId];
    await sql`
      INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, created_at)
      VALUES (${p.rowId}, ${a}, ${b}, ${p.reason}, ${now})
      ON CONFLICT (a_client_id, b_client_id, reason) DO NOTHING`;
  }
}

// ---------- Пул и потребность ----------

/** Карточки пула, готовые к раздаче: без владельца, «новая», без задержки. */
export async function poolReadyCount(sql: Sql, spaceId: string): Promise<number> {
  const [r] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM cards WHERE space_id = ${spaceId} AND owner_user_id IS NULL AND state = 'new' AND hold_reason = ''`;
  return r?.n ?? 0;
}

/** Участники раздачи, работающие в местный день (без «Отсутствует»); для сегодняшнего дня ещё и без «Паузы». */
export async function operatorsByDay(
  sql: Sql,
  spaceId: string,
  roles: readonly string[],
  days: readonly string[],
  pauseDay: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>(days.map((d) => [d, 0]));
  if (days.length === 0 || roles.length === 0) return out;
  const rows = await sql<{ day: string; n: number }>`
    SELECT d.day, count(m.user_id)::int AS n
      FROM unnest(${[...days]}::text[]) AS d(day)
      JOIN memberships m ON m.space_id = ${spaceId} AND m.status = 'active' AND m.in_distribution
                        AND m.role_key = ANY(${[...roles]}::text[])
      JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE NOT EXISTS (
             SELECT 1 FROM absences a
              WHERE a.space_id = m.space_id AND a.user_id = m.user_id AND a.cancelled_at IS NULL
                AND d.day BETWEEN a.from_day AND a.to_day)
       AND (${pauseDay}::text IS NULL OR d.day <> ${pauseDay}::text OR m.paused_on <> d.day)
     GROUP BY d.day`;
  for (const r of rows) out.set(r.day, r.n);
  return out;
}

/** Выдачи за местные сутки, входящие в лимит. */
export async function issuedOnDay(sql: Sql, spaceId: string, day: string): Promise<number> {
  const [r] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM assign_log WHERE space_id = ${spaceId} AND day = ${day} AND counts_to_cap AND to_user_id IS NOT NULL`;
  return r?.n ?? 0;
}

/** Сроки возврата карточек «Не интересует», наступающие не позже `untilMs` (просроченные тоже). */
export async function returnDates(sql: Sql, spaceId: string, untilMs: number): Promise<number[]> {
  const rows = await sql<{ returnAt: number }>`
    SELECT return_at FROM cards WHERE space_id = ${spaceId} AND state = 'not_interested' AND return_at IS NOT NULL AND return_at <= ${untilMs}`;
  return rows.map((r) => r.returnAt);
}

// ---------- Входящее из мессенджера (O7a, D-271) ----------

/**
 * Клиенты по рабочему номеру: слитые — к выжившему, без повторов. Для каждого — последнее касание карточки в
 * пространстве (null — карточки нет). Служебное чтение под блокировкой приёма: охвата нет намеренно.
 */
export async function clientsByDigits(sql: Sql, a: { spaceId: string; digits: string }): Promise<{ clientId: string; lastTouchAt: number | null; createdAt: number }[]> {
  return sql<{ clientId: string; lastTouchAt: number | null; createdAt: number }>`
    WITH RECURSIVE chain(id, merged_into_id, depth) AS (
      SELECT c.id, c.merged_into_id, 0 FROM clients c
       WHERE c.id IN (SELECT cp.client_id FROM client_phones cp WHERE cp.digits = ${a.digits})
      UNION ALL
      SELECT c.id, c.merged_into_id, chain.depth + 1 FROM chain JOIN clients c ON c.id = chain.merged_into_id WHERE chain.depth < 20
    )
    SELECT c.id AS client_id, max(k.last_touch_at) AS last_touch_at, c.created_at
      FROM (SELECT DISTINCT id FROM chain WHERE merged_into_id IS NULL) s
      JOIN clients c ON c.id = s.id AND c.depersonalized_at IS NULL
      LEFT JOIN cards k ON k.client_id = c.id AND k.space_id = ${a.spaceId}
     GROUP BY c.id, c.created_at
     ORDER BY max(k.last_touch_at) DESC NULLS LAST, c.created_at, c.id`;
}

/** Новых клиентов источника с момента `since` (суточный предел входящих из мессенджера). */
export async function countSourceClientsSince(sql: Sql, a: { sourceKey: string; since: number }): Promise<number> {
  const [r] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM client_sources WHERE source_kind = 'messenger' AND source_key = ${a.sourceKey} AND first_seen_at >= ${a.since}`;
  return r?.n ?? 0;
}

// ---------- «Предложить контакт» (D-258) ----------
// Как и остальной приём, без scopeSql: проверка номера идёт по всей базе, наружу уходит только «принято».

/** Предложение по id (повтор opId): чьё оно. */
export async function findProposal(sql: Sql, id: string): Promise<{ userId: string } | null> {
  const rows = await sql<{ userId: string }>`SELECT user_id FROM proposals WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function countProbesOnDay(sql: Sql, userId: string, day: string): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${userId} AND day = ${day}`;
  return rows[0]?.n ?? 0;
}

export async function insertProbeRow(sql: Sql, p: { id: string; userId: string; day: string; path: 'proposal'; matched: boolean; now: number }): Promise<void> {
  await sql`INSERT INTO phone_probes (id, user_id, day, path, matched, created_at)
            VALUES (${p.id}, ${p.userId}, ${p.day}, ${p.path}, ${p.matched}, ${p.now})`;
}

/** Первый не слитый клиент с таким номером (по давности создания) или null. */
export async function firstClientByPhone(sql: Sql, digits: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    SELECT cp.client_id AS id FROM client_phones cp JOIN clients o ON o.id = cp.client_id
     WHERE cp.digits = ${digits} AND o.merged_into_id IS NULL
     ORDER BY o.created_at, o.id LIMIT 1`;
  return rows[0]?.id ?? null;
}

export async function insertProposal(
  sql: Sql,
  p: { id: string; spaceId: string; userId: string; digits: string; name: string; status: 'created' | 'review'; matchedClientId: string | null; clientId: string | null; now: number },
): Promise<void> {
  await sql`
    INSERT INTO proposals (id, space_id, user_id, digits, name, status, matched_client_id, client_id, created_at)
    VALUES (${p.id}, ${p.spaceId}, ${p.userId}, ${p.digits}, ${p.name}, ${p.status}, ${p.matchedClientId}, ${p.clientId}, ${p.now})`;
}

/** Сводное уведомление; повтор по `dedupeKey` ничего не пишет. */
export async function insertNotificationRow(
  sql: Sql,
  n: { id: string; userId: string; kind: string; params: Record<string, unknown>; dedupeKey: string; now: number },
): Promise<void> {
  await sql`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${n.id}, ${n.userId}, ${n.kind}, '', '', ${jsonParam(n.params)}, ${n.dedupeKey}, ${n.now}, ${n.now})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

export async function insertClientEventRow(
  sql: Sql,
  e: { id: string; clientId: string; spaceId: string; kind: string; actorId: string | null; now: number; data: Record<string, unknown> },
): Promise<void> {
  await sql`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${e.id}, ${e.clientId}, ${e.spaceId}, NULL, ${e.kind}, ${e.actorId}, ${e.now}, '', '', ${jsonParam(e.data)})`;
}

/** Номер в стоп-листе (по HMAC). */
export async function phoneInStopList(sql: Sql, phoneHmac: string): Promise<boolean> {
  const rows = await sql<{ hit: number }>`SELECT 1 AS hit FROM stop_list WHERE phone_hmac = ${phoneHmac}`;
  return rows.length > 0;
}
