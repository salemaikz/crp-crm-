// Весь SQL модуля импорта (дизайн C4d §5–§8, §11). Охват — пространство: каждый запрос к imports идёт с
// space_id = пространство действующего. Кандидаты дедупа и стоп-лист глобальны, как у приёма: клиент общий
// на установку (D-012). Пакетные вставки — через unnest пачками по 500 строк (у драйвера нет sql(obj)).
import type { calling } from '@crm/core';
import { jsonParam, type Sql } from '@/server/platform/db/core';
import type { ImportReportV1 } from './types';

export const BATCH = 500;

export function chunks<T>(rows: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const col = <T, K>(rows: readonly T[], f: (r: T) => K): K[] => rows.map(f);

// ---------- Загрузки ----------

export interface ImportRow {
  id: string;
  spaceId: string;
  fileName: string;
  fileSha256: string;
  profileKey: string;
  status: 'preview' | 'applied' | 'failed';
  report: ImportReportV1;
  createdBy: string | null;
  createdAt: number;
  appliedAt: number | null;
}

export async function insertImport(
  sql: Sql,
  v: { id: string; spaceId: string; fileName: string; fileSha256: string; profileKey: string; report: ImportReportV1; createdBy: string | null; now: number },
): Promise<void> {
  await sql`
    INSERT INTO imports (id, space_id, file_name, file_sha256, profile_key, status, report, created_by, created_at)
    VALUES (${v.id}, ${v.spaceId}, ${v.fileName}, ${v.fileSha256}, ${v.profileKey}, 'preview', ${jsonParam(v.report)}, ${v.createdBy}, ${v.now})`;
}

export interface NewImportRow {
  id: string;
  rowNo: number;
  importKey: string;
  parsed: unknown;
  issue: string;
}

export async function insertImportRows(sql: Sql, importId: string, rows: readonly NewImportRow[], now: number): Promise<void> {
  for (const part of chunks(rows)) {
    await sql`
      INSERT INTO import_rows (id, import_id, row_no, import_key, parsed, issue, created_at)
      SELECT u.id, ${importId}, u.row_no, u.import_key, u.parsed::jsonb, u.issue, ${now}
        FROM unnest(${col(part, (r) => r.id)}::text[], ${col(part, (r) => r.rowNo)}::int[], ${col(part, (r) => r.importKey)}::text[],
                    ${col(part, (r) => JSON.stringify(r.parsed))}::text[], ${col(part, (r) => r.issue)}::text[])
             AS u(id, row_no, import_key, parsed, issue)`;
  }
}

/** Импорт пространства. `lock` — FOR UPDATE (применение). Чужое пространство = нет строки. */
export async function selectImport(sql: Sql, spaceId: string, id: string, lock = false): Promise<ImportRow | null> {
  const rows = lock
    ? await sql<ImportRow>`SELECT * FROM imports WHERE id = ${id} AND space_id = ${spaceId} FOR UPDATE`
    : await sql<ImportRow>`SELECT * FROM imports WHERE id = ${id} AND space_id = ${spaceId}`;
  return rows[0] ?? null;
}

export interface ImportListRow extends ImportRow {
  hasRows: boolean;
}

export async function selectImports(sql: Sql, spaceId: string, limit: number): Promise<ImportListRow[]> {
  return sql<ImportListRow>`
    SELECT i.*, EXISTS (SELECT 1 FROM import_rows r WHERE r.import_id = i.id) AS has_rows
      FROM imports i WHERE i.space_id = ${spaceId} ORDER BY i.created_at DESC, i.id LIMIT ${limit}`;
}

/** Значения колонки «оператор» файла (ярлыки для карты владельцев при ownerBy = column). */
export async function selectOperatorLabels(sql: Sql, importId: string): Promise<string[]> {
  const rows = await sql<{ label: string }>`
    SELECT DISTINCT parsed ->> 'operatorLabel' AS label FROM import_rows
     WHERE import_id = ${importId} AND parsed ->> 'operatorLabel' IS NOT NULL ORDER BY 1 LIMIT 500`;
  return rows.map((r) => r.label);
}

export async function hasRows(sql: Sql, importId: string): Promise<boolean> {
  const [r] = await sql<{ hit: boolean }>`SELECT EXISTS (SELECT 1 FROM import_rows WHERE import_id = ${importId}) AS hit`;
  return r?.hit === true;
}

export async function findAppliedSameFile(sql: Sql, spaceId: string, sha: string, profileKey: string): Promise<{ id: string; appliedAt: number } | null> {
  const [r] = await sql<{ id: string; appliedAt: number }>`
    SELECT id, applied_at FROM imports
     WHERE space_id = ${spaceId} AND file_sha256 = ${sha} AND profile_key = ${profileKey} AND status = 'applied'
     ORDER BY applied_at DESC LIMIT 1`;
  return r ?? null;
}

export async function saveReport(sql: Sql, id: string, report: ImportReportV1): Promise<void> {
  await sql`UPDATE imports SET report = ${jsonParam(report)} WHERE id = ${id}`;
}

export async function finishApply(sql: Sql, id: string, now: number, report: ImportReportV1): Promise<void> {
  await sql`UPDATE imports SET status = 'applied', applied_at = ${now}, report = ${jsonParam(report)} WHERE id = ${id}`;
}

export async function failImport(sql: Sql, id: string, report: ImportReportV1): Promise<void> {
  await sql`UPDATE imports SET status = 'failed', report = ${jsonParam(report)} WHERE id = ${id} AND status = 'preview'`;
}

export interface StoredRow {
  rowNo: number;
  importKey: string;
  parsed: unknown;
}

export async function selectRows(sql: Sql, importId: string): Promise<StoredRow[]> {
  return sql<StoredRow>`SELECT row_no, import_key, parsed FROM import_rows WHERE import_id = ${importId} ORDER BY row_no`;
}

/** `client_id` строк импорта проставляется при применении одним UPDATE … FROM unnest. */
export async function linkRowClients(sql: Sql, importId: string, links: readonly { rowNo: number; clientId: string }[]): Promise<void> {
  for (const part of chunks(links)) {
    await sql`
      UPDATE import_rows r SET client_id = u.client_id
        FROM unnest(${col(part, (l) => l.rowNo)}::int[], ${col(part, (l) => l.clientId)}::text[]) AS u(row_no, client_id)
       WHERE r.import_id = ${importId} AND r.row_no = u.row_no`;
  }
}

/** Чистка по сроку (дизайн §11): пачками по 5 000, срок — свой у каждого пространства. Возвращает число удалённых. */
export async function purgeRowsBefore(sql: Sql, spaceId: string, cutoff: number, limit = 5000): Promise<number> {
  const r = await sql<{ id: string }>`
    DELETE FROM import_rows WHERE id IN (
      SELECT r.id FROM import_rows r JOIN imports i ON i.id = r.import_id
       WHERE i.space_id = ${spaceId} AND r.created_at < ${cutoff} LIMIT ${limit}) RETURNING id`;
  return r.length;
}

// ---------- Аудит ----------

export async function insertAudit(sql: Sql, a: { id: string; actorId: string | null; spaceId: string; action: string; entityId: string; meta: Record<string, unknown>; now: number }): Promise<void> {
  await sql`
    INSERT INTO audit_log (id, actor_id, space_id, action, entity, entity_id, meta, created_at)
    VALUES (${a.id}, ${a.actorId}, ${a.spaceId}, ${a.action}, 'import', ${a.entityId}, ${jsonParam(a.meta)}, ${a.now})`;
}

// ---------- Входы предпросмотра ----------

export interface CandidateRow {
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
 * Клиенты базы, у которых есть общий ключ со строками файла: БИН, HMAC ИИН, рабочий или записанный
 * номер, нормализованное название. Слитые и обезличенные не участвуют. `headKey` — ключ поля клиента с
 * руководителем (fieldTargets.head); нет значения — первый действующий контакт.
 */
export async function selectCandidates(
  sql: Sql,
  keys: { orgIds: readonly string[]; iinHmacs: readonly string[]; phones: readonly string[]; nameNorms: readonly string[]; headKey: string | null },
): Promise<CandidateRow[]> {
  if (keys.orgIds.length + keys.iinHmacs.length + keys.phones.length + keys.nameNorms.length === 0) return [];
  const orgIds = [...keys.orgIds];
  const iins = [...keys.iinHmacs];
  const phones = [...keys.phones];
  const names = [...keys.nameNorms];
  return sql<CandidateRow>`
    SELECT c.id, c.name_norm, c.legal_form, c.org_id, c.iin_hmac, c.created_at,
           COALESCE(array_agg(p.digits) FILTER (WHERE p.is_working), '{}') AS phones,
           COALESCE(array_agg(p.digits) FILTER (WHERE NOT p.is_working), '{}') AS stubs,
           COALESCE(NULLIF(c.custom ->> ${keys.headKey}::text, ''),
                    (SELECT ct.name FROM contacts ct WHERE ct.client_id = c.id AND ct.archived_at IS NULL
                      ORDER BY ct.is_decision_maker DESC, ct.created_at, ct.id LIMIT 1)) AS head
      FROM clients c LEFT JOIN client_phones p ON p.client_id = c.id
     WHERE c.merged_into_id IS NULL AND c.depersonalized_at IS NULL
       AND (
            (c.org_id <> '' AND c.org_id = ANY(${orgIds}::text[]))
         OR (c.iin_hmac IS NOT NULL AND c.iin_hmac = ANY(${iins}::text[]))
         OR c.id IN (SELECT cp.client_id FROM client_phones cp WHERE cp.digits = ANY(${phones}::text[]))
         OR (c.name_norm <> '' AND c.name_norm = ANY(${names}::text[]))
       )
     GROUP BY c.id`;
}

export async function selectStopListHits(sql: Sql, hashes: readonly string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await sql<{ phoneHmac: string }>`SELECT phone_hmac FROM stop_list WHERE phone_hmac = ANY(${[...hashes]}::text[])`;
  return new Set(rows.map((r) => r.phoneHmac));
}

export interface PriorRow {
  rowKey: string;
  stateKey: string;
  touchedInCrm: boolean;
  clientId: string;
  cardId: string;
  /** Последнее применение строки отложило рабочий итог (`import.row` с `deferred: true`, D-115). */
  deferred: boolean;
  ownerUserId: string | null;
  holdReason: string;
}

/** Прошлое состояние строк (D-114): источник строки + последнее событие import.row с ключом состояния. */
export async function selectPrior(sql: Sql, spaceId: string, sourceKey: string, rowKeys: readonly string[]): Promise<PriorRow[]> {
  if (rowKeys.length === 0) return [];
  return sql<PriorRow>`
    SELECT cs.external_id AS row_key, cs.client_id, c.id AS card_id, c.touched_in_crm, c.owner_user_id, c.hold_reason,
           ev.state_key, ev.deferred
      FROM client_sources cs
      JOIN clients cl ON cl.id = cs.client_id AND cl.merged_into_id IS NULL
      JOIN cards c ON c.client_id = cs.client_id AND c.space_id = ${spaceId}
      JOIN LATERAL (
        SELECT e.data ->> 'stateKey' AS state_key, COALESCE(e.data ->> 'deferred', '') = 'true' AS deferred
          FROM client_events e
         WHERE e.client_id = cs.client_id AND e.space_id = ${spaceId} AND e.kind = 'import.row'
           AND e.data ->> 'rowKey' = cs.external_id
         ORDER BY e.at DESC, e.id DESC LIMIT 1
      ) ev ON ev.state_key IS NOT NULL
     WHERE cs.source_key = ${sourceKey} AND cs.external_id = ANY(${[...rowKeys]}::text[])`;
}

export interface Participant {
  userId: string;
  name: string;
}

/** Активные участники раздачи пространства: кому можно отдать строки. */
export async function selectParticipants(sql: Sql, spaceId: string, roles: readonly string[]): Promise<Participant[]> {
  if (roles.length === 0) return [];
  return sql<Participant>`
    SELECT u.id AS user_id, u.name
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = ${spaceId} AND m.status = 'active' AND m.role_key = ANY(${[...roles]}::text[]) AND u.status = 'active'
     ORDER BY u.name, u.id`;
}

// ---------- Запись: чтение состояния ----------

export interface CardRow {
  id: string;
  clientId: string;
  ownerUserId: string | null;
  actingUserId: string | null;
  actingUntilDay: string;
  state: calling.CardState;
  holdReason: calling.HoldReason;
  attempts: number;
  nextCallAt: number | null;
  returnAt: number | null;
  lpr: calling.Lpr;
  isTarget: calling.Target;
  lastOutcomeCode: string;
  lastOutcomeKind: calling.OutcomeKind | '';
  lastOutcomeAt: number | null;
  closeReasonCode: string;
  closedAt: number | null;
  assignedAt: number | null;
  touchedInCrm: boolean;
  callsTotal: number;
  connectsTotal: number;
  noAnswerTotal: number;
  firstConnectAt: number | null;
  lastConnectAt: number | null;
  lastTouchAt: number | null;
  version: number;
}

export async function selectCards(sql: Sql, spaceId: string, clientIds: readonly string[]): Promise<CardRow[]> {
  if (clientIds.length === 0) return [];
  return sql<CardRow>`
    SELECT id, client_id, owner_user_id, acting_user_id, acting_until_day, state, hold_reason, attempts, next_call_at, return_at,
           lpr, is_target, last_outcome_code, last_outcome_kind, last_outcome_at, close_reason_code, closed_at, assigned_at,
           touched_in_crm, calls_total, connects_total, no_answer_total, first_connect_at, last_connect_at, last_touch_at, version
      FROM cards WHERE space_id = ${spaceId} AND client_id = ANY(${[...clientIds]}::text[])`;
}

export interface ClientFillRow {
  id: string;
  region: string;
  address: string;
  orgId: string;
  iinHmac: string | null;
  custom: Record<string, unknown>;
  name: string;
}

export async function selectClientsForFill(sql: Sql, ids: readonly string[]): Promise<ClientFillRow[]> {
  if (ids.length === 0) return [];
  return sql<ClientFillRow>`SELECT id, name, region, address, org_id, iin_hmac, custom FROM clients WHERE id = ANY(${[...ids]}::text[])`;
}

export interface PhoneRow {
  id: string;
  clientId: string;
  digits: string;
  isWorking: boolean;
  isPrimary: boolean;
}

export async function selectPhones(sql: Sql, clientIds: readonly string[]): Promise<PhoneRow[]> {
  if (clientIds.length === 0) return [];
  return sql<PhoneRow>`
    SELECT id, client_id, digits, is_working, is_primary FROM client_phones
     WHERE client_id = ANY(${[...clientIds]}::text[]) ORDER BY is_primary DESC, created_at, id`;
}

/** Владельцы номеров среди не слитых клиентов: цифры → id клиентов. По нему видно общий номер (бухгалтер у разных ТОО). */
export async function selectDigitOwners(sql: Sql, digits: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (digits.length === 0) return out;
  const rows = await sql<{ digits: string; clientId: string }>`
    SELECT cp.digits, cp.client_id FROM client_phones cp JOIN clients c ON c.id = cp.client_id
     WHERE cp.digits = ANY(${[...digits]}::text[]) AND c.merged_into_id IS NULL`;
  for (const r of rows) {
    let set = out.get(r.digits);
    if (!set) out.set(r.digits, (set = new Set()));
    set.add(r.clientId);
  }
  return out;
}

// ---------- Запись: пакетные вставки ----------

export interface NewClientRow {
  id: string;
  name: string;
  nameNorm: string;
  legalForm: string;
  orgId: string;
  iinHmac: string | null;
  region: string;
  address: string;
  custom: Record<string, unknown>;
  searchNorm: string;
  sourceKey: string;
}

export async function insertClients(sql: Sql, rows: readonly NewClientRow[], now: number): Promise<void> {
  for (const p of chunks(rows)) {
    await sql`
      INSERT INTO clients (id, kind, name, name_norm, legal_form, org_id, iin_hmac, region, address, custom, search_norm,
                           source_kind, source_key, created_at, updated_at)
      SELECT u.id, 'company', u.name, u.name_norm, u.legal_form, u.org_id, u.iin_hmac, u.region, u.address, u.custom::jsonb,
             u.search_norm, 'import', u.source_key, ${now}, ${now}
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.name)}::text[], ${col(p, (r) => r.nameNorm)}::text[],
                    ${col(p, (r) => r.legalForm)}::text[], ${col(p, (r) => r.orgId)}::text[], ${col(p, (r) => r.iinHmac)}::text[],
                    ${col(p, (r) => r.region)}::text[], ${col(p, (r) => r.address)}::text[], ${col(p, (r) => JSON.stringify(r.custom))}::text[],
                    ${col(p, (r) => r.searchNorm)}::text[], ${col(p, (r) => r.sourceKey)}::text[])
             AS u(id, name, name_norm, legal_form, org_id, iin_hmac, region, address, custom, search_norm, source_key)`;
  }
}

export interface NewPhoneRow {
  id: string;
  clientId: string;
  digits: string;
  kind: string;
  isPrimary: boolean;
  /** false — номер из таблицы признан нерабочим («Недоступен» при единственном номере). */
  isWorking: boolean;
}

/** Номера клиентов; повтор (client_id, digits) не создаёт второй строки. Флаги идут текстом: драйвер не умеет boolean[]. */
export async function insertPhones(sql: Sql, rows: readonly NewPhoneRow[], now: number): Promise<void> {
  for (const p of chunks(rows)) {
    await sql`
      INSERT INTO client_phones (id, client_id, digits, kind, is_working, is_primary, created_at)
      SELECT u.id, u.client_id, u.digits, u.kind, u.is_working::boolean, u.is_primary::boolean, ${now}
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.clientId)}::text[], ${col(p, (r) => r.digits)}::text[],
                    ${col(p, (r) => r.kind)}::text[], ${col(p, (r) => String(r.isWorking))}::text[], ${col(p, (r) => String(r.isPrimary))}::text[])
             AS u(id, client_id, digits, kind, is_working, is_primary)
      ON CONFLICT (client_id, digits) DO NOTHING`;
  }
}

export interface NewSourceRow {
  id: string;
  clientId: string;
  sourceKey: string;
  importId: string;
  externalId: string;
}

export async function insertSources(sql: Sql, rows: readonly NewSourceRow[], now: number): Promise<void> {
  for (const p of chunks(rows)) {
    await sql`
      INSERT INTO client_sources (id, client_id, source_kind, source_key, import_id, external_id, first_seen_at)
      SELECT u.id, u.client_id, 'import', u.source_key, u.import_id, u.external_id, ${now}
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.clientId)}::text[], ${col(p, (r) => r.sourceKey)}::text[],
                    ${col(p, (r) => r.importId)}::text[], ${col(p, (r) => r.externalId)}::text[]) AS u(id, client_id, source_key, import_id, external_id)
      ON CONFLICT DO NOTHING`;
  }
}

export interface NewCardRow extends Omit<CardRow, 'actingUserId' | 'actingUntilDay' | 'touchedInCrm' | 'version'> {
  spaceId: string;
  holdCode: string;
  custom: Record<string, unknown>;
}

export async function insertCards(sql: Sql, rows: readonly NewCardRow[], now: number): Promise<void> {
  for (const p of chunks(rows)) {
    await sql`
      INSERT INTO cards (id, space_id, client_id, owner_user_id, state, hold_reason, hold_code, attempts, next_call_at, return_at, lpr,
                         is_target, last_outcome_code, last_outcome_kind, last_outcome_at, close_reason_code, closed_at, assigned_at,
                         calls_total, connects_total, no_answer_total, first_connect_at, last_connect_at, last_touch_at, custom,
                         created_at, updated_at)
      SELECT u.id, u.space_id, u.client_id, u.owner_user_id, u.state, u.hold_reason, u.hold_code, u.attempts, u.next_call_at, u.return_at,
             u.lpr, u.is_target, u.last_outcome_code, u.last_outcome_kind, u.last_outcome_at, u.close_reason_code, u.closed_at, u.assigned_at,
             u.calls_total, u.connects_total, u.no_answer_total, u.first_connect_at, u.last_connect_at, u.last_touch_at, u.custom::jsonb,
             ${now}, ${now}
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.spaceId)}::text[], ${col(p, (r) => r.clientId)}::text[],
                    ${col(p, (r) => r.ownerUserId)}::text[], ${col(p, (r) => r.state)}::text[], ${col(p, (r) => r.holdReason)}::text[],
                    ${col(p, (r) => r.holdCode)}::text[], ${col(p, (r) => r.attempts)}::int[], ${col(p, (r) => r.nextCallAt)}::bigint[],
                    ${col(p, (r) => r.returnAt)}::bigint[], ${col(p, (r) => r.lpr)}::text[], ${col(p, (r) => r.isTarget)}::text[],
                    ${col(p, (r) => r.lastOutcomeCode)}::text[], ${col(p, (r) => r.lastOutcomeKind)}::text[], ${col(p, (r) => r.lastOutcomeAt)}::bigint[],
                    ${col(p, (r) => r.closeReasonCode)}::text[], ${col(p, (r) => r.closedAt)}::bigint[], ${col(p, (r) => r.assignedAt)}::bigint[],
                    ${col(p, (r) => r.callsTotal)}::int[], ${col(p, (r) => r.connectsTotal)}::int[], ${col(p, (r) => r.noAnswerTotal)}::int[],
                    ${col(p, (r) => r.firstConnectAt)}::bigint[], ${col(p, (r) => r.lastConnectAt)}::bigint[], ${col(p, (r) => r.lastTouchAt)}::bigint[],
                    ${col(p, (r) => JSON.stringify(r.custom))}::text[])
             AS u(id, space_id, client_id, owner_user_id, state, hold_reason, hold_code, attempts, next_call_at, return_at, lpr, is_target,
                  last_outcome_code, last_outcome_kind, last_outcome_at, close_reason_code, closed_at, assigned_at, calls_total,
                  connects_total, no_answer_total, first_connect_at, last_connect_at, last_touch_at, custom)`;
  }
}

export interface NewAssignRow {
  id: string;
  cardId: string;
  toUserId: string;
  runId: string;
  day: string;
  actorId: string | null;
}

/** Выдача импортом: не входит в лимит дня (counts_to_cap = false). */
export async function insertAssignLog(sql: Sql, spaceId: string, rows: readonly NewAssignRow[], now: number): Promise<void> {
  for (const p of chunks(rows)) {
    await sql`
      INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
      SELECT u.id, ${spaceId}, u.card_id, NULL, u.to_user_id, 'import', FALSE, u.run_id, u.day, u.actor_id, ${now}
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.cardId)}::text[], ${col(p, (r) => r.toUserId)}::text[],
                    ${col(p, (r) => r.runId)}::text[], ${col(p, (r) => r.day)}::text[], ${col(p, (r) => r.actorId)}::text[])
             AS u(id, card_id, to_user_id, run_id, day, actor_id)`;
  }
}

export interface NewCallRow {
  id: string;
  cardId: string;
  clientId: string;
  ownerAtCall: string | null;
  outcomeCode: string;
  outcomeKind: string;
  lpr: string;
  applied: 'applied' | 'fact_only';
  factReason: string;
  occurredAt: number;
  importKey: string;
}

/** Импортный звонок: user_id = NULL, via = 'import' (D-067); повтор по import_key — пропуск. */
export async function insertCalls(sql: Sql, spaceId: string, rows: readonly NewCallRow[], now: number, configRev: number): Promise<number> {
  let n = 0;
  for (const p of chunks(rows)) {
    const r = await sql<{ id: string }>`
      INSERT INTO calls (id, space_id, card_id, client_id, user_id, owner_user_id_at_call, direction, via, outcome_code, outcome_kind, lpr,
                         applied, fact_reason, occurred_at, received_at, import_key, config_rev)
      SELECT u.id, ${spaceId}, u.card_id, u.client_id, NULL, u.owner_at_call, 'out', 'import', u.outcome_code, u.outcome_kind, u.lpr,
             u.applied, u.fact_reason, u.occurred_at, ${now}, u.import_key, ${configRev}
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.cardId)}::text[], ${col(p, (r) => r.clientId)}::text[],
                    ${col(p, (r) => r.ownerAtCall)}::text[], ${col(p, (r) => r.outcomeCode)}::text[], ${col(p, (r) => r.outcomeKind)}::text[],
                    ${col(p, (r) => r.lpr)}::text[], ${col(p, (r) => r.applied)}::text[], ${col(p, (r) => r.factReason)}::text[],
                    ${col(p, (r) => r.occurredAt)}::bigint[], ${col(p, (r) => r.importKey)}::text[])
             AS u(id, card_id, client_id, owner_at_call, outcome_code, outcome_kind, lpr, applied, fact_reason, occurred_at, import_key)
      ON CONFLICT DO NOTHING
      RETURNING id`;
    n += r.length;
  }
  return n;
}

export interface NewEventRow {
  id: string;
  clientId: string;
  kind: string;
  actorId: string | null;
  at: number;
  refType: string;
  refId: string;
  data: Record<string, unknown>;
}

export async function insertEvents(sql: Sql, spaceId: string, rows: readonly NewEventRow[]): Promise<void> {
  for (const p of chunks(rows)) {
    await sql`
      INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
      SELECT u.id, u.client_id, ${spaceId}, u.kind, u.actor_id, u.at, u.ref_type, u.ref_id, u.data::jsonb
        FROM unnest(${col(p, (r) => r.id)}::text[], ${col(p, (r) => r.clientId)}::text[], ${col(p, (r) => r.kind)}::text[],
                    ${col(p, (r) => r.actorId)}::text[], ${col(p, (r) => r.at)}::bigint[], ${col(p, (r) => r.refType)}::text[],
                    ${col(p, (r) => r.refId)}::text[], ${col(p, (r) => JSON.stringify(r.data))}::text[])
             AS u(id, client_id, kind, actor_id, at, ref_type, ref_id, data)`;
  }
}

export interface NewPairRow {
  id: string;
  a: string;
  b: string;
  reason: 'shared_phone' | 'name_and_head';
}

/** Спорные пары: a < b, повтор не создаёт второй строки. Возвращает число созданных. */
export async function insertPairs(sql: Sql, rows: readonly NewPairRow[], now: number): Promise<number> {
  let n = 0;
  for (const p of chunks(rows)) {
    const r = await sql<{ id: string }>`
      INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, created_at)
      SELECT u.id, LEAST(u.a, u.b), GREATEST(u.a, u.b), u.reason, ${now}
        FROM unnest(${col(p, (x) => x.id)}::text[], ${col(p, (x) => x.a)}::text[], ${col(p, (x) => x.b)}::text[], ${col(p, (x) => x.reason)}::text[])
             AS u(id, a, b, reason)
      ON CONFLICT (a_client_id, b_client_id, reason) DO NOTHING
      RETURNING id`;
    n += r.length;
  }
  return n;
}

// ---------- Запись: точечные ----------

/** Слияние: дописать пустые поля клиента; БИН/ИИН — только если ещё ни у кого нет (уникальные индексы). */
export async function fillClient(
  sql: Sql,
  id: string,
  p: { region: string | null; address: string | null; orgId: string | null; iinHmac: string | null; custom: Record<string, unknown> | null; searchAppend: string | null },
  now: number,
): Promise<void> {
  await sql`
    UPDATE clients SET
      region      = COALESCE(${p.region}::text, region),
      address     = COALESCE(${p.address}::text, address),
      org_id      = CASE WHEN ${p.orgId}::text IS NOT NULL AND org_id = ''
                          AND NOT EXISTS (SELECT 1 FROM clients o WHERE o.org_id = ${p.orgId}::text AND o.id <> clients.id AND o.merged_into_id IS NULL)
                         THEN ${p.orgId}::text ELSE org_id END,
      iin_hmac    = CASE WHEN ${p.iinHmac}::text IS NOT NULL AND iin_hmac IS NULL
                          AND NOT EXISTS (SELECT 1 FROM clients o WHERE o.iin_hmac = ${p.iinHmac}::text AND o.id <> clients.id AND o.merged_into_id IS NULL)
                         THEN ${p.iinHmac}::text ELSE iin_hmac END,
      custom      = COALESCE(${p.custom ? jsonParam(p.custom) : null}::jsonb, custom),
      search_norm = CASE WHEN ${p.searchAppend}::text IS NULL THEN search_norm ELSE btrim(search_norm || ' ' || ${p.searchAppend}::text) END,
      updated_at  = ${now}
    WHERE id = ${id}`;
}

export async function markPhoneNotWorking(sql: Sql, clientId: string, digits: string): Promise<void> {
  await sql`UPDATE client_phones SET is_working = FALSE, is_primary = FALSE WHERE client_id = ${clientId} AND digits = ${digits}`;
}

export interface CardUpdate {
  ownerUserId: string | null;
  assignedAt: number | null;
  state: string;
  holdReason: string;
  attempts: number;
  nextCallAt: number | null;
  returnAt: number | null;
  lpr: string;
  isTarget: string;
  lastOutcomeCode: string;
  lastOutcomeKind: string;
  lastOutcomeAt: number | null;
  closeReasonCode: string;
  closedAt: number | null;
  callsTotal: number;
  connectsTotal: number;
  noAnswerTotal: number;
  firstConnectAt: number | null;
  lastConnectAt: number | null;
  lastTouchAt: number | null;
}

/** Правка карточки по состоянию из таблицы: только если её не трогали в CRM и версия та же. 0 строк = «оставлено как в CRM». */
export async function updateCardFromImport(sql: Sql, cardId: string, version: number, u: CardUpdate, now: number): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE cards SET owner_user_id = ${u.ownerUserId}, assigned_at = ${u.assignedAt}, state = ${u.state}, hold_reason = ${u.holdReason}, attempts = ${u.attempts}, next_call_at = ${u.nextCallAt},
           return_at = ${u.returnAt}, lpr = ${u.lpr}, is_target = ${u.isTarget}, last_outcome_code = ${u.lastOutcomeCode},
           last_outcome_kind = ${u.lastOutcomeKind}, last_outcome_at = ${u.lastOutcomeAt}, close_reason_code = ${u.closeReasonCode},
           closed_at = ${u.closedAt}, calls_total = ${u.callsTotal}, connects_total = ${u.connectsTotal},
           no_answer_total = ${u.noAnswerTotal}, first_connect_at = ${u.firstConnectAt}, last_connect_at = ${u.lastConnectAt},
           last_touch_at = ${u.lastTouchAt}, version = version + 1, updated_at = ${now}
     WHERE id = ${cardId} AND version = ${version} AND touched_in_crm = FALSE
    RETURNING id`;
  return r.length > 0;
}

/** Закрыть открытые задачи клиента в пространстве: все или только проекцию перезвона (D-050). */
export async function closeTasks(sql: Sql, spaceId: string, clientId: string, which: 'all' | 'callback', now: number): Promise<void> {
  if (which === 'all') {
    await sql`UPDATE tasks SET status = 'cancelled', done_at = ${now} WHERE space_id = ${spaceId} AND client_id = ${clientId} AND status = 'open'`;
  } else {
    await sql`
      UPDATE tasks SET status = 'cancelled', done_at = ${now}
       WHERE space_id = ${spaceId} AND client_id = ${clientId} AND status = 'open'
         AND source IN ('callback','no_show','rebook','clarify_import')`;
  }
}

export interface NewTaskRow {
  id: string;
  clientId: string;
  kind: 'call' | 'check';
  source: 'callback' | 'clarify_import' | 'stoplist_confirm';
  assigneeUserId: string | null;
  dueAt: number | null;
  sourceKey: string;
  createdBy: string | null;
}

/** Автозадачи: повтор по source_key (открытая) не дублируется. Название пустое — подпись по `source` строит интерфейс. */
export async function insertTasks(sql: Sql, spaceId: string, rows: readonly NewTaskRow[], now: number): Promise<number> {
  let n = 0;
  for (const p of chunks(rows)) {
    const r = await sql<{ id: string }>`
      INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
      SELECT u.id, ${spaceId}, u.client_id, u.kind, u.source, '', u.due_at, u.assignee, 'open', u.source_key, u.created_by, ${now}
        FROM unnest(${col(p, (x) => x.id)}::text[], ${col(p, (x) => x.clientId)}::text[], ${col(p, (x) => x.kind)}::text[],
                    ${col(p, (x) => x.source)}::text[], ${col(p, (x) => x.dueAt)}::bigint[], ${col(p, (x) => x.assigneeUserId)}::text[],
                    ${col(p, (x) => x.sourceKey)}::text[], ${col(p, (x) => x.createdBy)}::text[])
             AS u(id, client_id, kind, source, due_at, assignee, source_key, created_by)
      ON CONFLICT DO NOTHING
      RETURNING id`;
    n += r.length;
  }
  return n;
}

/** Номера в стоп-лист по HMAC (источник import); повтор — пропуск. */
export async function insertStopList(sql: Sql, rows: readonly { hmac: string; reason: string }[], actorId: string | null, now: number): Promise<number> {
  let n = 0;
  for (const p of chunks(rows)) {
    const r = await sql<{ phoneHmac: string }>`
      INSERT INTO stop_list (phone_hmac, reason_code, source, created_by, created_at)
      SELECT u.hmac, u.reason, 'import', ${actorId}, ${now}
        FROM unnest(${col(p, (x) => x.hmac)}::text[], ${col(p, (x) => x.reason)}::text[]) AS u(hmac, reason)
      ON CONFLICT (phone_hmac) DO NOTHING
      RETURNING phone_hmac`;
    n += r.length;
  }
  return n;
}
