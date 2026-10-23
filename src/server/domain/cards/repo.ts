// Весь SQL карточки обзвона (docs/calls-design.md §3–§5). Первый аргумент — соединение транзакции.
// Строки карточки блокируются с охватом (scopeSql) либо без него — только по путям из шапки types.ts.
// Порядок блокировок: карточка → (мероприятие → записи) → задачи и прочее.
import type { calling } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import { writeAudit, type AuditAction } from '@/server/platform/audit';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import { phoneHmac } from '@/server/platform/hmac';
import type { CardActor, CardEventPerm, LockedCardRow } from './types';

export const actorUserId = (a: CardActor): string | null => (a.kind === 'user' ? a.userId : null);

/** Источник строки стоп-листа, поставленной обезличиванием клиента: она не снимается ни одним путём (D-321). */
export const STOP_SOURCE_DEPERSONALIZE = 'depersonalize';

// ---------------------------------------------------------------------------
// Снимок и блокировка
// ---------------------------------------------------------------------------

type CardDb = Omit<calling.CardSnapshot, 'phones'> & { spaceId: string; lastOutcomeKind: string };

interface PhoneDb {
  id: string;
  digits: string;
  kind: 'mobile' | 'landline' | 'unknown';
  isWorking: boolean;
  isPrimary: boolean;
  sharedWithOtherClient: boolean;
  heldByOtherDncClient: boolean;
}

/** Номера клиента карточки с признаками для ядра (без блокировки): основной, мобильные, по времени добавления. */
async function loadPhones(sql: Sql, a: { clientId: string; spaceId: string }): Promise<{ phones: calling.PhoneSnapshot[]; digits: Map<string, string> }> {
  const rows = await sql<PhoneDb>`
    SELECT p.id, p.digits, p.kind, p.is_working, p.is_primary,
           EXISTS (SELECT 1 FROM client_phones o JOIN clients oc ON oc.id = o.client_id AND oc.merged_into_id IS NULL
                    WHERE o.digits = p.digits AND o.client_id <> p.client_id) AS shared_with_other_client,
           EXISTS (SELECT 1 FROM client_phones o JOIN cards ok ON ok.client_id = o.client_id
                    WHERE o.digits = p.digits AND o.client_id <> p.client_id
                      AND ok.space_id = ${a.spaceId} AND ok.state = 'do_not_call') AS held_by_other_dnc_client
      FROM client_phones p WHERE p.client_id = ${a.clientId}
     ORDER BY p.is_primary DESC, (p.kind = 'mobile') DESC, p.created_at, p.id`;
  const hmacs = rows.map((r) => phoneHmac(r.digits));
  const stopped = hmacs.length === 0 ? [] : await sql<{ phoneHmac: string; source: string }>`SELECT phone_hmac, source FROM stop_list WHERE phone_hmac = ANY(${hmacs})`;
  const inStop = new Set(stopped.map((s) => s.phoneHmac));
  // Строку обезличивания не снимает никто (D-321): для ядра номер «держит» другой — как клиент в «Не звонить»
  const pinned = new Set(stopped.filter((s) => s.source === STOP_SOURCE_DEPERSONALIZE).map((s) => s.phoneHmac));
  return {
    phones: rows.map((r, i) => ({
      id: r.id,
      kind: r.kind,
      isWorking: r.isWorking,
      isPrimary: r.isPrimary,
      inStopList: inStop.has(hmacs[i]!),
      sharedWithOtherClient: r.sharedWithOtherClient,
      heldByOtherDncClient: r.heldByOtherDncClient || pinned.has(hmacs[i]!),
    })),
    digits: new Map(rows.map((r) => [r.id, r.digits])),
  };
}

async function toLocked(sql: Sql, row: CardDb): Promise<LockedCardRow> {
  const { spaceId, lastOutcomeKind, ...rest } = row;
  const p = await loadPhones(sql, { clientId: row.clientId, spaceId });
  return {
    spaceId,
    snapshot: { ...rest, lastOutcomeKind: lastOutcomeKind as calling.OutcomeKind | '', phones: p.phones },
    phoneDigits: p.digits,
  };
}


/** Блокировка с охватом: чужая и несуществующая карточка неотличимы (null). */
export async function lockCardScoped(tx: Sql, viewer: Viewer, cardId: string, perm: CardEventPerm): Promise<LockedCardRow | null> {
  const rows = await scoped(tx)<CardDb>`
    SELECT c.id, c.space_id, c.client_id, c.owner_user_id, c.acting_user_id, c.acting_until_day, c.state, c.hold_reason, c.attempts,
           c.next_call_at, c.return_at, c.lpr, c.is_target, c.last_outcome_code, c.last_outcome_kind, c.last_outcome_at, c.close_reason_code,
           c.closed_at, c.assigned_at, c.touched_in_crm, c.calls_total, c.connects_total, c.no_answer_total, c.first_connect_at,
           c.last_connect_at, c.last_touch_at, c.callback_reason, c.callback_touches, c.next_call_precision, c.version
      FROM cards c
     WHERE c.id = ${cardId} AND ${scopeSql(viewer, 'card', perm)}
       FOR UPDATE OF c`;
  return rows[0] ? toLocked(tx, rows[0]) : null;
}

/** Без охвата: только для порта записи и проверки «был владельцем» (D-175). null — карточки нет. */
export async function lockCardUnscoped(tx: Sql, cardId: string): Promise<LockedCardRow | null> {
  const rows = await tx<CardDb>`
    SELECT c.id, c.space_id, c.client_id, c.owner_user_id, c.acting_user_id, c.acting_until_day, c.state, c.hold_reason, c.attempts,
           c.next_call_at, c.return_at, c.lpr, c.is_target, c.last_outcome_code, c.last_outcome_kind, c.last_outcome_at, c.close_reason_code,
           c.closed_at, c.assigned_at, c.touched_in_crm, c.calls_total, c.connects_total, c.no_answer_total, c.first_connect_at,
           c.last_connect_at, c.last_touch_at, c.callback_reason, c.callback_touches, c.next_call_precision, c.version
      FROM cards c WHERE c.id = ${cardId} FOR UPDATE OF c`;
  return rows[0] ? toLocked(tx, rows[0]) : null;
}

/** Снимок без блокировки (карточку уже заблокировал вызывающий — порт записи). */
export async function loadSnapshot(tx: Sql, cardId: string): Promise<LockedCardRow | null> {
  const rows = await tx<CardDb>`
    SELECT c.id, c.space_id, c.client_id, c.owner_user_id, c.acting_user_id, c.acting_until_day, c.state, c.hold_reason, c.attempts,
           c.next_call_at, c.return_at, c.lpr, c.is_target, c.last_outcome_code, c.last_outcome_kind, c.last_outcome_at, c.close_reason_code,
           c.closed_at, c.assigned_at, c.touched_in_crm, c.calls_total, c.connects_total, c.no_answer_total, c.first_connect_at,
           c.last_connect_at, c.last_touch_at, c.callback_reason, c.callback_touches, c.next_call_precision, c.version
      FROM cards c WHERE c.id = ${cardId}`;
  return rows[0] ? toLocked(tx, rows[0]) : null;
}

/** Назначалась ли карточка когда-либо сотруднику (без блокировки): отсекает чужие карточки до `FOR UPDATE` без охвата. */
export async function wasEverAssignedTo(tx: Sql, input: { cardId: string; userId: string }): Promise<boolean> {
  const rows = await tx<{ n: number }>`SELECT 1 AS n FROM assign_log WHERE card_id = ${input.cardId} AND to_user_id = ${input.userId} LIMIT 1`;
  return rows.length > 0;
}

/** Был ли сотрудник владельцем или временным владельцем карточки в момент `at` (D-175). Нет строк — false. */
export async function wasOwnerAt(tx: Sql, input: { cardId: string; userId: string; at: number }): Promise<boolean> {
  const rows = await tx<{ toUserId: string | null }>`
    SELECT to_user_id FROM assign_log WHERE card_id = ${input.cardId} AND created_at <= ${input.at}
     ORDER BY created_at DESC, id DESC LIMIT 1`;
  return rows[0]?.toUserId === input.userId;
}

// ---------------------------------------------------------------------------
// Запись перехода
// ---------------------------------------------------------------------------

export interface CallInsert {
  id: string;
  spaceId: string;
  cardId: string;
  clientId: string;
  userId: string | null;
  ownerUserIdAtCall: string | null;
  via: calling.CallVia | 'board';
  callbackPrecision: calling.CallbackPrecision;
  phoneDigits: string;
  outcomeCode: string;
  outcomeKind: calling.OutcomeKind;
  reasonCode: string;
  note: string;
  lpr: calling.Lpr;
  callbackAt: number | null;
  fieldsPatch: Readonly<Record<string, unknown>>;
  applied: 'applied' | 'fact_only';
  factReason: calling.FactReason;
  tappedAt: number | null;
  occurredAt: number;
  receivedAt: number;
  durationSec: number | null;
  durationSource: 'none' | 'manual_estimate';
  configRev: number;
}

/** `ON CONFLICT (id) DO NOTHING`: false — строка с таким id уже есть. */
export async function insertCall(tx: Sql, c: CallInsert): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    INSERT INTO calls (id, space_id, card_id, client_id, user_id, owner_user_id_at_call, direction, via, phone_digits, outcome_code,
                       outcome_kind, reason_code, note, lpr, callback_at, fields_patch, applied, fact_reason, tapped_at, occurred_at,
                       received_at, duration_sec, duration_source, config_rev, callback_precision)
    VALUES (${c.id}, ${c.spaceId}, ${c.cardId}, ${c.clientId}, ${c.userId}, ${c.ownerUserIdAtCall}, 'out', ${c.via}, ${c.phoneDigits},
            ${c.outcomeCode}, ${c.outcomeKind}, ${c.reasonCode}, ${c.note}, ${c.lpr}, ${c.callbackAt}, ${jsonParam(c.fieldsPatch)},
            ${c.applied}, ${c.factReason}, ${c.tappedAt}, ${c.occurredAt}, ${c.receivedAt}, ${c.durationSec}, ${c.durationSource},
            ${c.configRev}, ${c.callbackPrecision})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length === 1;
}

/** Запись карточки по версии: 0 строк = ошибка сборки (под блокировкой так не бывает). */
export async function updateCardRow(tx: Sql, card: calling.CardSnapshot, beforeVersion: number, at: number): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    UPDATE cards SET
      owner_user_id = ${card.ownerUserId}, acting_user_id = ${card.actingUserId}, acting_until_day = ${card.actingUntilDay},
      state = ${card.state}, hold_reason = ${card.holdReason}, attempts = ${card.attempts}, next_call_at = ${card.nextCallAt},
      return_at = ${card.returnAt}, lpr = ${card.lpr}, is_target = ${card.isTarget}, last_outcome_code = ${card.lastOutcomeCode},
      last_outcome_kind = ${card.lastOutcomeKind}, last_outcome_at = ${card.lastOutcomeAt}, close_reason_code = ${card.closeReasonCode},
      closed_at = ${card.closedAt}, assigned_at = ${card.assignedAt}, touched_in_crm = ${card.touchedInCrm},
      calls_total = ${card.callsTotal}, connects_total = ${card.connectsTotal}, no_answer_total = ${card.noAnswerTotal},
      first_connect_at = ${card.firstConnectAt}, last_connect_at = ${card.lastConnectAt}, last_touch_at = ${card.lastTouchAt},
      callback_reason = ${card.callbackReason}, callback_touches = ${card.callbackTouches}, next_call_precision = ${card.nextCallPrecision},
      version = ${card.version}, updated_at = ${at}
    WHERE id = ${card.id} AND version = ${beforeVersion}
    RETURNING id`;
  return rows.length === 1;
}

/** Флаги номера: сначала снять основной у теряющих, потом поставить новому (уникальный индекс одного основного). */
export async function updatePhoneFlags(
  tx: Sql,
  clientId: string,
  changes: ReadonlyArray<{ id: string; isWorking: boolean; isPrimary: boolean }>,
): Promise<void> {
  for (const p of changes.filter((x) => !x.isPrimary)) {
    await tx`UPDATE client_phones SET is_working = ${p.isWorking}, is_primary = FALSE WHERE id = ${p.id} AND client_id = ${clientId}`;
  }
  for (const p of changes.filter((x) => x.isPrimary)) {
    await tx`UPDATE client_phones SET is_working = ${p.isWorking}, is_primary = TRUE WHERE id = ${p.id} AND client_id = ${clientId}`;
  }
}

// ---------------------------------------------------------------------------
// Повтор итога
// ---------------------------------------------------------------------------

export interface PriorCallRow {
  applied: 'applied' | 'fact_only';
  factReason: calling.FactReason;
  userId: string | null;
  cardId: string;
}

/** Прежний итог с тем же opId; читать ПОСЛЕ блокировки карточки. */
export async function findPriorCall(tx: Sql, opId: string): Promise<PriorCallRow | null> {
  const rows = await tx<PriorCallRow>`SELECT applied, fact_reason, user_id, card_id FROM calls WHERE id = ${opId}`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Эффекты
// ---------------------------------------------------------------------------

export async function addToStopList(tx: Sql, a: { digits: string; reasonCode: string; createdBy: string | null; at: number }): Promise<void> {
  await tx`
    INSERT INTO stop_list (phone_hmac, reason_code, source, created_by, created_at)
    VALUES (${phoneHmac(a.digits)}, ${a.reasonCode}, 'outcome', ${a.createdBy}, ${a.at})
    ON CONFLICT (phone_hmac) DO NOTHING`;
}

/** Снять номер со стоп-листа. Строка обезличивания остаётся всегда — второй рубеж после снимка карточки (D-321). */
export async function removeFromStopList(tx: Sql, digits: string): Promise<void> {
  await tx`DELETE FROM stop_list WHERE phone_hmac = ${phoneHmac(digits)} AND source <> ${STOP_SOURCE_DEPERSONALIZE}`;
}

export async function insertAssignLog(
  tx: Sql,
  a: { spaceId: string; cardId: string; fromUserId: string | null; toUserId: string | null; kind: calling.AssignKind; countsToCap: boolean; runId: string; day: string; actorId: string | null; at: number },
): Promise<void> {
  await tx`
    INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
    VALUES (${newId()}, ${a.spaceId}, ${a.cardId}, ${a.fromUserId}, ${a.toUserId}, ${a.kind}, ${a.countsToCap}, ${a.runId}, ${a.day}, ${a.actorId}, ${a.at})`;
}

export async function insertNotification(
  tx: Sql,
  a: { userId: string; kind: string; entityType: string; entityId: string; dedupeKey: string | null; at: number },
): Promise<void> {
  await tx`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${a.userId}, ${a.kind}, ${a.entityType}, ${a.entityId}, ${jsonParam({})}, ${a.dedupeKey}, ${a.at}, ${a.at})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

export async function insertClientEvent(
  tx: Sql,
  a: { clientId: string; spaceId: string; kind: string; actorId: string | null; at: number; refType: string; refId: string; data: Record<string, unknown> },
): Promise<void> {
  await tx`
    INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${a.clientId}, ${a.spaceId}, ${a.kind}, ${a.actorId}, ${a.at}, ${a.refType}, ${a.refId}, ${jsonParam(a.data)})`;
}

export async function insertSkipRow(tx: Sql, a: { id: string; spaceId: string; userId: string; cardId: string; day: string; at: number }): Promise<void> {
  await tx`
    INSERT INTO skips (id, space_id, user_id, card_id, day, created_at)
    VALUES (${a.id}, ${a.spaceId}, ${a.userId}, ${a.cardId}, ${a.day}, ${a.at})
    ON CONFLICT (id) DO NOTHING`;
}

export async function writeCardAudit(
  tx: Sql,
  a: { actorId: string | null; action: Extract<AuditAction, 'card.dnc_cleared' | 'card.merged'>; cardId: string; spaceId: string; meta: Record<string, unknown>; at: number },
): Promise<void> {
  await writeAudit(tx, { actorId: a.actorId, action: a.action, entity: 'card', entityId: a.cardId, spaceId: a.spaceId, meta: a.meta, createdAt: a.at });
}

/**
 * Руководитель для `{ role: 'lead' }` (D-176): `teams.lead_user_id` команды владельца, если он активен в пространстве
 * и его роль входит в `roleKeys` (task.read с охватом space/all, сначала роли с card.outcome); иначе первый такой сотрудник пространства.
 */
export async function findLead(tx: Sql, a: { spaceId: string; ownerUserId: string | null; roleKeys: readonly string[] }): Promise<string | null> {
  if (a.roleKeys.length === 0) return null;
  if (a.ownerUserId) {
    const own = await tx<{ id: string }>`
      SELECT t.lead_user_id AS id
        FROM memberships om
        JOIN teams t ON t.id = om.team_id AND t.archived_at IS NULL
        JOIN memberships lm ON lm.user_id = t.lead_user_id AND lm.space_id = ${a.spaceId} AND lm.status = 'active' AND lm.role_key = ANY(${[...a.roleKeys]})
        JOIN users lu ON lu.id = lm.user_id AND lu.status = 'active'
       WHERE om.user_id = ${a.ownerUserId} AND om.space_id = ${a.spaceId}`;
    if (own[0]) return own[0].id;
  }
  const first = await tx<{ id: string }>`
    SELECT m.user_id AS id FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND m.role_key = ANY(${[...a.roleKeys]})
     ORDER BY array_position(${[...a.roleKeys]}::text[], m.role_key), m.created_at, m.user_id LIMIT 1`;
  return first[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Поля шторки, настройки, сверка
// ---------------------------------------------------------------------------

/** Значения полей карточки (`cards.custom`) и клиента (`clients.custom`) под блокировкой карточки. */
export async function readCustom(tx: Sql, a: { cardId: string; clientId: string }): Promise<{ card: Record<string, unknown>; client: Record<string, unknown> }> {
  const c = await tx<{ custom: Record<string, unknown> }>`SELECT custom FROM cards WHERE id = ${a.cardId}`;
  const cl = await tx<{ custom: Record<string, unknown> }>`SELECT custom FROM clients WHERE id = ${a.clientId}`;
  return { card: c[0]?.custom ?? {}, client: cl[0]?.custom ?? {} };
}

export async function writeCardCustom(tx: Sql, viewer: Viewer, cardId: string, custom: Record<string, unknown>, at: number): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE cards c SET custom = ${jsonParam(custom)}, updated_at = ${at}
     WHERE c.id = ${cardId} AND ${scopeSql(viewer, 'card', 'card.edit')} RETURNING c.id`;
  return rows.length === 1;
}

export async function writeClientCustom(tx: Sql, viewer: Viewer, clientId: string, custom: Record<string, unknown>, at: number): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE clients cl SET custom = ${jsonParam(custom)}, updated_at = ${at}
     WHERE cl.id = ${clientId} AND ${scopeSql(viewer, 'client', 'client.edit')} RETURNING cl.id`;
  return rows.length === 1;
}

/**
 * Когда ревизия настроек пространства архивировала итог: создана первая ревизия после последней, где итог
 * ещё не был архивным. Нет ревизий — итог в карте отсутствует (ядро трактует как «время неизвестно»).
 */
export async function archivedAtOfOutcomes(sql: Sql, spaceId: string, keys: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const key of keys) {
    const rows = await sql<{ at: number | null }>`
      SELECT min(r.created_at) AS at FROM config_revisions r
       WHERE r.scope = ${spaceId}
         AND r.rev > COALESCE((
           SELECT max(p.rev) FROM config_revisions p
            WHERE p.scope = ${spaceId} AND jsonb_typeof(p.doc->'calling'->'outcomes') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.doc->'calling'->'outcomes') o
                           WHERE o->>'key' = ${key} AND COALESCE((o->>'archived')::boolean, FALSE) = FALSE)), 0)`;
    const at = rows[0]?.at;
    if (at !== null && at !== undefined) out.set(key, Number(at));
  }
  return out;
}

/** Рабочие карточки без владельца, кроме `new` (часть ночной сверки, D-066). Только число. */
export async function countOwnerlessWorking(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM cards c
     WHERE c.owner_user_id IS NULL AND c.state IN ('retry','callback') AND c.hold_reason <> 'merged'`;
  return rows[0]?.n ?? 0;
}

/** Запись полей карточки с ростом версии (правка из карточки клиента, C8): устаревшие шторки итога увидят `stale`. */
export async function writeCardCustomBumped(tx: Sql, viewer: Viewer, cardId: string, custom: Record<string, unknown>, at: number): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE cards c SET custom = ${jsonParam(custom)}, version = c.version + 1, updated_at = ${at}
     WHERE c.id = ${cardId} AND ${scopeSql(viewer, 'card', 'card.edit')} RETURNING c.id`;
  return rows.length === 1;
}

/** Сотрудник активен и состоит в пространстве (получатель возврата в обзвон, владелец карточки). */
export async function userActiveInSpace(tx: Sql, a: { spaceId: string; userId: string }): Promise<boolean> {
  const rows = await tx<{ hit: number }>`
    SELECT 1 AS hit FROM users u JOIN memberships m ON m.user_id = u.id AND m.space_id = ${a.spaceId} AND m.status = 'active'
     WHERE u.id = ${a.userId} AND u.status = 'active'`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// № 33: выход из «Договорились»
// ---------------------------------------------------------------------------

/** Состояние, в которое карточку уже перевёл № 33 с этим `opId` (идемпотентность); null — такого действия не было. */
export async function findMoveOpState(tx: Sql, a: { clientId: string; opId: string }): Promise<string | null> {
  const rows = await tx<{ toState: string | null }>`
    SELECT data->>'toState' AS to_state FROM client_events
     WHERE client_id = ${a.clientId} AND kind = 'card.state' AND ref_type = 'card_move' AND ref_id = ${a.opId}
     LIMIT 1`;
  return rows[0] ? (rows[0].toState ?? '') : null;
}

/** Будущие активные записи клиента (для «нужна перезапись» при выходе без явки). Карточка заблокирована вызывающим. */
export async function listFutureActiveBookingIds(tx: Sql, a: { spaceId: string; clientId: string; after: number; statuses: readonly string[] }): Promise<string[]> {
  const rows = await tx<{ id: string }>`
    SELECT b.id FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.status = ANY(${[...a.statuses]}) AND b.starts_at > ${a.after}
     ORDER BY b.id`;
  return rows.map((r) => r.id);
}
