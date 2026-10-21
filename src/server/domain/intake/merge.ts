// Слияние клиентов спорной пары (B9b, docs/tasks-team-design.md §7.3, D-257, D-062, D-068, D-272). За флагом
// `FEATURE_MERGE`: выключен — 404. Предпросмотр читает обе стороны без блокировок и отдаёт план с отпечатком;
// применение под блокировками пересчитывает план и принимает только тот же отпечаток. Правила состояния карточки —
// ядро `calling` (№ 24) через общий путь ручных событий; здесь порядок, перенос ссылок и снимок «до».
import { calling, fields } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { applyCardEventLocked, loadCallingContext, toCoreActor, type LockedCardRow } from '@/server/domain/cards';
import { loadSnapshot, lockCardScoped } from '@/server/domain/cards/repo';
import { loadClientsConfig } from '@/server/domain/clients/config';
import { reassignOpenTasks } from '@/server/domain/tasks/auto';
import { writeAudit } from '@/server/platform/audit';
import { getDb, newId, type Sql } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { mergeBadRequest, mergeConflict } from './mergeErrors';
import {
  fillEmpty,
  hasBookingConflict,
  mergeConflicts,
  mergeFingerprint,
  planCards,
  planPhones,
  type ClientFill,
  type FillField,
  type MergeClientRow,
  type MergeConflict,
  type MoveTable,
} from './mergePlan';
import {
  lockMergeKeys,
  markLoserMerged,
  moveCardRefs,
  moveLoserCard,
  moveLoserPhones,
  moveLoserRows,
  opIdTaken,
  pairVisible,
  releaseDupPairHolds,
  repointPairs,
  retireLoserCard,
  selectAllDigits,
  selectMergeBookings,
  selectMergeCardIds,
  selectMergeClients,
  selectMoveIds,
  selectPairRow,
  selectPhones,
  selectPriorMerge,
  selectUserNames,
  writeMergeSnapshots,
  writeSurvivorFields,
  type PairRow,
} from './mergeRepo';
import { insertClientEventRow } from './repo';

export type OwnerFrom = 'auto' | 'survivor' | 'other';

export interface MergeChoice {
  /** Какая сторона пары остаётся. */
  survivor: 'a' | 'b';
  /** Чей владелец остаётся: по последнему итогу, выжившего или проигравшего. */
  owner: OwnerFrom;
}

export interface MergeInput extends MergeChoice {
  opId: string;
  fingerprint: string;
}

export interface MergePreview {
  pairId: string;
  survivorClientId: string;
  loserClientId: string;
  owner: OwnerFrom;
  /** Итог в пространстве зрителя (ядро на снимках); null — у клиентов нет карточек здесь. */
  result: { state: calling.CardState; ownerUserId: string | null; ownerName: string | null } | null;
  /** Сколько строк переедет, по таблицам (только ненулевые). */
  moves: Partial<Record<MoveTable, number>>;
  /** Номера проигравшего: переедут и совпавшие с номерами выжившего (удалятся). */
  phones: { moved: number; duplicates: number };
  /** Пустые поля выжившего, которые заполнятся. */
  fills: FillField[];
  conflicts: MergeConflict[];
  fingerprint: string;
}

export interface MergeResult {
  survivorClientId: string;
  loserClientId: string;
  counts: Record<string, number>;
  replayed: boolean;
}

/** Флаг модуля: выключен — раздела нет (404). */
export function mergeEnabled(): boolean {
  return isFeatureEnabled('MERGE');
}

function requireMerge(viewer: Viewer): string {
  if (!mergeEnabled() || viewer.spaceId === null) throw new NotFoundError();
  return viewer.spaceId;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Состояние пары и план (общие для предпросмотра и применения)
// ---------------------------------------------------------------------------

interface MergeState {
  pair: PairRow;
  survivor: MergeClientRow;
  loser: MergeClientRow;
  /** Карточки обоих клиентов, видимые по `client.merge`, в порядке id. */
  cards: LockedCardRow[];
  hiddenCards: boolean;
  phones: { move: string[]; drop: string[] };
  moveIds: Awaited<ReturnType<typeof selectMoveIds>>;
  fill: { next: ClientFill; filled: FillField[] };
  conflicts: MergeConflict[];
  fingerprint: string;
}

/**
 * Обе стороны пары. `lock` — применение: клиенты FOR UPDATE по id, затем карточки по id (lockCardScoped), затем
 * строка пары. Без `lock` — предпросмотр, те же чтения без блокировок.
 */
async function loadState(sql: Sql, viewer: Viewer, pair: PairRow, choice: MergeChoice, now: number, lock: boolean): Promise<MergeState> {
  const survivorId = choice.survivor === 'a' ? pair.aClientId : pair.bClientId;
  const loserId = choice.survivor === 'a' ? pair.bClientId : pair.aClientId;
  const clients = await selectMergeClients(sql, [survivorId, loserId], lock);
  const survivor = clients.find((c) => c.id === survivorId);
  const loser = clients.find((c) => c.id === loserId);
  if (!survivor || !loser) throw new NotFoundError();
  if (survivor.mergedIntoId !== null || loser.mergedIntoId !== null) throw mergeConflict('not_open');

  const ids = await selectMergeCardIds(sql, viewer, [survivorId, loserId]);
  const cards: LockedCardRow[] = [];
  for (const id of ids.visible) {
    const row = lock ? await lockCardScoped(sql, viewer, id, 'client.merge') : await loadSnapshot(sql, id);
    if (row) cards.push(row);
  }
  if (lock) {
    const locked = await selectPairRow(sql, pair.id, true);
    if (!locked || locked.status !== 'open') throw mergeConflict('not_open');
  }

  const phones = planPhones(
    (await selectPhones(sql, survivorId)).map((p) => p.digits),
    await selectPhones(sql, loserId),
  );
  const moveIds = await selectMoveIds(sql, loserId);
  const bookings = await selectMergeBookings(sql, [survivorId, loserId], now);
  const hiddenCards = cards.length < ids.total;
  const conflicts = mergeConflicts({ hiddenCards, bookingConflict: hasBookingConflict(survivorId, loserId, bookings, now) });
  const fingerprint = mergeFingerprint({
    pairId: pair.id,
    survivorId,
    ownerFrom: choice.owner,
    clients: clients.map((c) => ({ id: c.id, updatedAt: Number(c.updatedAt) })),
    cards: cards.map((c) => ({ id: c.snapshot.id, version: c.snapshot.version })),
    rows: { ...moveIds, client_phones: [...phones.move, ...phones.drop] },
  });
  return { pair, survivor, loser, cards, hiddenCards, phones, moveIds, fill: fillEmpty(survivor, loser), conflicts, fingerprint };
}

/** Пара по id; не видна зрителю ни одной стороной — как несуществующая. */
async function visiblePair(sql: Sql, viewer: Viewer, pairId: string): Promise<PairRow> {
  const pair = await selectPairRow(sql, pairId);
  if (!pair || !(await pairVisible(sql, viewer, pair, 'client.merge'))) throw new NotFoundError();
  return pair;
}

function cardsBySpace(state: MergeState) {
  const refs = state.cards.map((c) => ({ id: c.snapshot.id, spaceId: c.spaceId, clientId: c.snapshot.clientId, version: c.snapshot.version }));
  return planCards(state.survivor.id, state.loser.id, refs);
}

function mergeEvent(survivor: LockedCardRow, loser: LockedCardRow, owner: OwnerFrom, opId: string): calling.CardEvent {
  return { type: 'merge', opId, seenVersion: survivor.snapshot.version, other: loser.snapshot, ownerFrom: owner };
}

// ---------------------------------------------------------------------------
// Предпросмотр
// ---------------------------------------------------------------------------

export async function previewMerge(viewer: Viewer, pairId: string, choice: MergeChoice): Promise<MergePreview> {
  const spaceId = requireMerge(viewer);
  const now = viewer.now;
  const db = await getDb();
  const state = await (async () => {
    const pair = await visiblePair(db.sql, viewer, pairId);
    if (pair.status !== 'open') throw mergeConflict('not_open');
    return loadState(db.sql, viewer, pair, choice, now, false);
  })();

  // Итог в пространстве зрителя: ядро на снимках (ничего не пишет)
  const plan = cardsBySpace(state);
  const byId = new Map(state.cards.map((c) => [c.snapshot.id, c]));
  let result: MergePreview['result'] = null;
  const both = plan.merge.find((m) => m.spaceId === spaceId);
  const only = state.cards.find((c) => c.spaceId === spaceId);
  if (both) {
    const ctx = await loadCallingContext(spaceId, now);
    const s = byId.get(both.survivorCardId)!;
    const l = byId.get(both.loserCardId)!;
    const r = calling.applyOutcome({ card: s.snapshot, event: mergeEvent(s, l, choice.owner, 'preview'), actor: toCoreActor(viewer), now, settings: ctx.settings, calendar: ctx.calendar });
    if (r.status === 'applied') result = { state: r.card.state, ownerUserId: r.card.ownerUserId, ownerName: null };
  } else if (only) {
    result = { state: only.snapshot.state, ownerUserId: only.snapshot.ownerUserId, ownerName: null };
  }
  if (result?.ownerUserId) result.ownerName = (await selectUserNames(db.sql, [result.ownerUserId])).get(result.ownerUserId) ?? null;

  const moves: Partial<Record<MoveTable, number>> = {};
  for (const [table, ids] of Object.entries(state.moveIds)) if (ids.length > 0) moves[table as MoveTable] = ids.length;
  const loserCards = state.cards.filter((c) => c.snapshot.clientId === state.loser.id).length;
  if (loserCards > 0) moves.cards = loserCards;
  if (state.phones.move.length > 0) moves.client_phones = state.phones.move.length;

  return {
    pairId: state.pair.id,
    survivorClientId: state.survivor.id,
    loserClientId: state.loser.id,
    owner: choice.owner,
    result,
    moves,
    phones: { moved: state.phones.move.length, duplicates: state.phones.drop.length },
    fills: state.fill.filled,
    conflicts: state.conflicts,
    fingerprint: state.fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Применение
// ---------------------------------------------------------------------------

/**
 * Слияние одной транзакцией (§7.3): блокировки → повтор opId → пересчёт плана → отпечаток и конфликты → снимок
 * «до» → номера → ссылочные строки → карточки (ядро `merge`) → проигравший слит → поля выжившего → пары → лента и
 * аудит. Повтор с тем же opId возвращает прежний ответ, ничего не меняя.
 */
export async function applyMerge(viewer: Viewer, pairId: string, input: MergeInput, deps?: { now?: () => number }): Promise<MergeResult> {
  requireMerge(viewer);
  const cfg = await loadClientsConfig(viewer);
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx((tx) => mergeTx(tx, viewer, pairId, input, deps?.now?.() ?? viewer.now, cfg.searchable));
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}

async function mergeTx(tx: Sql, viewer: Viewer, pairId: string, input: MergeInput, now: number, searchable: string[]): Promise<MergeResult> {
  await lockMergeKeys(tx);
  const prior = await selectPriorMerge(tx, input.opId);
  if (prior) {
    if (prior.pairId !== pairId) throw mergeBadRequest('op_id');
    return { survivorClientId: prior.survivorId, loserClientId: prior.loserId, counts: prior.counts, replayed: true };
  }
  if (await opIdTaken(tx, input.opId)) throw mergeBadRequest('op_id');

  const pair = await visiblePair(tx, viewer, pairId);
  if (pair.status !== 'open') throw mergeConflict('not_open');
  const state = await loadState(tx, viewer, pair, input, now, true);
  if (state.fingerprint !== input.fingerprint) throw mergeConflict('changed');
  if (state.conflicts.length > 0) throw mergeConflict(state.conflicts[0]!);

  const s = state.survivor.id;
  const l = state.loser.id;
  const counts: Record<string, number> = {};
  counts.snapshots = await writeMergeSnapshots(tx, { opId: input.opId, actorId: viewer.userId, now, survivorId: s, loserId: l, cardIds: state.cards.map((c) => c.snapshot.id) });

  // 1–2. номера и ссылочные строки проигравшего
  await moveLoserPhones(tx, { loserId: l, survivorId: s, ...state.phones });
  counts.phonesMoved = state.phones.move.length;
  counts.phonesDropped = state.phones.drop.length;
  Object.assign(counts, await moveLoserRows(tx, { loserId: l, survivorId: s, now }));

  // 3. карточки по пространствам
  const plan = cardsBySpace(state);
  const byId = new Map(state.cards.map((c) => [c.snapshot.id, c]));
  for (const m of plan.merge) {
    const sc = byId.get(m.survivorCardId)!;
    const lc = byId.get(m.loserCardId)!;
    const ctx = await loadCallingContext(m.spaceId, now);
    const r = await applyCardEventLocked(tx, viewer, sc, ctx, mergeEvent(sc, lc, input.owner, input.opId), now, { opId: input.opId });
    if (r.status !== 'applied') throw mergeConflict('changed');
    // Ядро переназначает задачи прежних исполнителей выжившей карточки; задачи владельца и временного проигравшей
    // (переехали шагом 2) — тому же итоговому владельцу (D-254, D-272)
    const finalOwner = r.card.ownerUserId;
    const from = [lc.snapshot.ownerUserId, lc.snapshot.actingUserId].filter((u): u is string => u !== null && u !== finalOwner);
    if (finalOwner !== null && from.length > 0) {
      await reassignOpenTasks(tx, viewer, { spaceId: m.spaceId, clientId: s, fromUserIds: from, toUserId: finalOwner, at: now });
    }
    await moveCardRefs(tx, { fromCardId: lc.snapshot.id, toCardId: sc.snapshot.id, now });
    await retireLoserCard(tx, { cardId: lc.snapshot.id, now });
  }
  for (const m of plan.move) await moveLoserCard(tx, { cardId: m.cardId, survivorId: s, now });
  counts.cards = plan.merge.length + plan.move.length;

  // 4–5. проигравший слит, пустые поля выжившего и строка поиска
  await markLoserMerged(tx, { loserId: l, survivorId: s, now });
  const fill = state.fill.next;
  const searchNorm = fields.buildSearchNorm({
    name: state.survivor.name,
    orgId: fill.orgId,
    phones: await selectAllDigits(tx, s),
    custom: fill.custom as fields.CustomValues,
    searchable,
  });
  await writeSurvivorFields(tx, { survivorId: s, fill, searchNorm, now });

  // 6. пары; задержка «Возможный дубль» снимается, если открытых пар не осталось
  await repointPairs(tx, { pairId, loserId: l, survivorId: s, by: viewer.userId, now });
  counts.released = await releaseDupPairHolds(tx, [s], now);

  // 7. лента выжившего в каждом пространстве его карточек, аудит с ответом для повтора
  const spaces = [...new Set(state.cards.map((c) => c.spaceId))].sort();
  for (const spaceId of spaces) {
    await insertClientEventRow(tx, { id: newId(), clientId: s, spaceId, kind: 'client.merged', actorId: viewer.userId, now, data: { otherClientId: l } });
  }
  await writeAudit(tx, {
    actorId: viewer.userId,
    action: 'client.merge',
    entity: 'client',
    entityId: s,
    spaceId: viewer.spaceId,
    meta: { opId: input.opId, pairId, survivorId: s, loserId: l, owner: input.owner, counts },
    createdAt: now,
  });
  return { survivorClientId: s, loserClientId: l, counts, replayed: false };
}
