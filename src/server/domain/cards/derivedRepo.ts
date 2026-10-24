// SQL кэша признаков и горячести карточки (docs/pipeline-v2-design.md §5.1, §6). Источник — записи и выигранные сделки
// клиента в пространстве карточки. Запись кэша не меняет `version` и `updated_at`: это не правка карточки.
// Первый аргумент — исполнитель (Viewer, SystemActor или метка кэша, D-351): без охвата, потому что пересчёт идёт
// из транзакции записи карточки, которую уже проверил вызывающий, или из задания.
import type { calling } from '@crm/core';
import type { Sql } from '@/server/platform/db';
import type { DerivedActor } from './types';

/** Что пересчёт читает у карточки и её записей и сделок. */
export interface DerivedSource {
  id: string;
  spaceId: string;
  state: string;
  callbackReason: string;
  lpr: calling.Lpr;
  nextCallAt: number | null;
  nextCallPrecision: 'time' | 'day';
  attendedGroupAt: number | null;
  attendedIndividualAt: number | null;
  lastNoShowAt: number | null;
  lastNoShowKind: '' | 'group' | 'individual';
  purchasesTotal: number;
  lastPurchaseAt: number | null;
  /** Значения кэша сейчас: чтобы не писать то, что не изменилось. */
  cur: { attendedGroupAt: number | null; attendedIndividualAt: number | null; lastNoShowAt: number | null; lastNoShowKind: string; purchasesTotal: number; lastPurchaseAt: number | null; heat: number };
}

interface SourceRow extends Omit<DerivedSource, 'cur'> {
  curAttendedGroupAt: number | null;
  curAttendedIndividualAt: number | null;
  curLastNoShowAt: number | null;
  curLastNoShowKind: string;
  curPurchasesTotal: number;
  curLastPurchaseAt: number | null;
  curHeat: number;
}

const toSource = (r: SourceRow): DerivedSource => ({
  id: r.id,
  spaceId: r.spaceId,
  state: r.state,
  callbackReason: r.callbackReason,
  lpr: r.lpr,
  nextCallAt: r.nextCallAt,
  nextCallPrecision: r.nextCallPrecision,
  attendedGroupAt: r.attendedGroupAt,
  attendedIndividualAt: r.attendedIndividualAt,
  lastNoShowAt: r.lastNoShowAt,
  lastNoShowKind: r.lastNoShowKind,
  purchasesTotal: r.purchasesTotal,
  lastPurchaseAt: r.lastPurchaseAt,
  cur: {
    attendedGroupAt: r.curAttendedGroupAt,
    attendedIndividualAt: r.curAttendedIndividualAt,
    lastNoShowAt: r.curLastNoShowAt,
    lastNoShowKind: r.curLastNoShowKind,
    purchasesTotal: r.curPurchasesTotal,
    lastPurchaseAt: r.curLastPurchaseAt,
    heat: r.curHeat,
  },
});

/** Явки, неявки и покупки клиента карточки (пересчёт из источника, не приращение). */
export async function selectDerivedSources(_actor: DerivedActor, tx: Sql, cardIds: readonly string[]): Promise<DerivedSource[]> {
  if (cardIds.length === 0) return [];
  const rows = await tx<SourceRow>`
    SELECT c.id, c.space_id, c.state, c.callback_reason, c.lpr, c.next_call_at, c.next_call_precision,
           bk.attended_group_at, bk.attended_individual_at, bk.last_no_show_at, COALESCE(bk.last_no_show_kind, '') AS last_no_show_kind,
           COALESCE(dl.purchases_total, 0)::int AS purchases_total, dl.last_purchase_at,
           c.attended_group_at AS cur_attended_group_at, c.attended_individual_at AS cur_attended_individual_at,
           c.last_no_show_at AS cur_last_no_show_at, c.last_no_show_kind AS cur_last_no_show_kind,
           c.purchases_total AS cur_purchases_total, c.last_purchase_at AS cur_last_purchase_at, c.heat AS cur_heat
      FROM cards c
      LEFT JOIN LATERAL (
        SELECT max(b.starts_at) FILTER (WHERE b.status = 'attended' AND b.kind = 'group') AS attended_group_at,
               max(b.starts_at) FILTER (WHERE b.status = 'attended' AND b.kind = 'individual') AS attended_individual_at,
               max(b.starts_at) FILTER (WHERE b.status = 'no_show') AS last_no_show_at,
               (array_agg(b.kind ORDER BY b.starts_at DESC, b.id) FILTER (WHERE b.status = 'no_show'))[1] AS last_no_show_kind
          FROM bookings b WHERE b.client_id = c.client_id AND b.space_id = c.space_id AND b.status IN ('attended','no_show')) bk ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS purchases_total, max(d.won_at) AS last_purchase_at
          FROM deals d WHERE d.client_id = c.client_id AND d.space_id = c.space_id AND d.status = 'won') dl ON TRUE
     WHERE c.id = ANY(${[...cardIds]}::text[])
     ORDER BY c.id`;
  return rows.map(toSource);
}

/**
 * Занять карточки пачки, не ожидая занятых другой транзакцией (`FOR UPDATE SKIP LOCKED`); возвращает свободные id.
 * Источник читается только после этого: иначе запись, закоммитившаяся между чтением и блокировкой, была бы затёрта.
 */
export async function lockFreeCards(_actor: DerivedActor, tx: Sql, cardIds: readonly string[]): Promise<string[]> {
  if (cardIds.length === 0) return [];
  const rows = await tx<{ id: string }>`SELECT id FROM cards WHERE id = ANY(${[...cardIds]}::text[]) ORDER BY id FOR UPDATE SKIP LOCKED`;
  return rows.map((r) => r.id);
}

export interface DerivedWrite {
  id: string;
  attendedGroupAt: number | null;
  attendedIndividualAt: number | null;
  lastNoShowAt: number | null;
  lastNoShowKind: string;
  purchasesTotal: number;
  lastPurchaseAt: number | null;
  heat: number;
}

/**
 * Записать кэш. Без `version` и `updated_at`. `skipLocked` — пачечный пересчёт: строку, которую сейчас пишет другая
 * транзакция, пропускаем (её запись сама пересчитает кэш в своей транзакции). Возвращает число записанных строк.
 */
export async function writeDerived(_actor: DerivedActor, tx: Sql, rows: readonly DerivedWrite[], opts: { skipLocked: boolean }): Promise<number> {
  if (rows.length === 0) return 0;
  let list = rows;
  if (opts.skipLocked) {
    const free = await tx<{ id: string }>`SELECT id FROM cards WHERE id = ANY(${rows.map((r) => r.id)}::text[]) ORDER BY id FOR UPDATE SKIP LOCKED`;
    const ok = new Set(free.map((r) => r.id));
    list = rows.filter((r) => ok.has(r.id));
    if (list.length === 0) return 0;
  }
  const updated = await tx<{ id: string }>`
    WITH v AS (
      SELECT * FROM unnest(${list.map((r) => r.id)}::text[], ${list.map((r) => r.attendedGroupAt)}::bigint[], ${list.map((r) => r.attendedIndividualAt)}::bigint[],
                           ${list.map((r) => r.lastNoShowAt)}::bigint[], ${list.map((r) => r.lastNoShowKind)}::text[], ${list.map((r) => r.purchasesTotal)}::int[],
                           ${list.map((r) => r.lastPurchaseAt)}::bigint[], ${list.map((r) => r.heat)}::int[])
        AS t(id, attended_group_at, attended_individual_at, last_no_show_at, last_no_show_kind, purchases_total, last_purchase_at, heat))
    UPDATE cards c SET attended_group_at = v.attended_group_at, attended_individual_at = v.attended_individual_at,
           last_no_show_at = v.last_no_show_at, last_no_show_kind = v.last_no_show_kind, purchases_total = v.purchases_total,
           last_purchase_at = v.last_purchase_at, heat = v.heat
      FROM v
     WHERE c.id = v.id
       AND (c.attended_group_at, c.attended_individual_at, c.last_no_show_at, c.last_no_show_kind, c.purchases_total, c.last_purchase_at, c.heat)
           IS DISTINCT FROM (v.attended_group_at, v.attended_individual_at, v.last_no_show_at, v.last_no_show_kind, v.purchases_total, v.last_purchase_at, v.heat)
    RETURNING c.id`;
  return updated.length;
}

/** Пачка карточек пространства после курсора по id (пересчёт всех, пачками). */
export async function selectCardIdsPage(_actor: DerivedActor, tx: Sql, a: { spaceId: string; afterId: string; limit: number }): Promise<string[]> {
  const rows = await tx<{ id: string }>`SELECT id FROM cards WHERE space_id = ${a.spaceId} AND id > ${a.afterId} ORDER BY id LIMIT ${a.limit}`;
  return rows.map((r) => r.id);
}

/** Карточки клиента в пространстве (обычно одна). */
export async function selectCardIdsOfClient(_actor: DerivedActor, tx: Sql, a: { spaceId: string; clientId: string }): Promise<string[]> {
  const rows = await tx<{ id: string }>`SELECT id FROM cards WHERE space_id = ${a.spaceId} AND client_id = ${a.clientId}`;
  return rows.map((r) => r.id);
}

/** Последний полный пересчёт задачи (`job_runs`): отпечаток весов и время окончания. Только числа в stats. */
export async function selectLastFullPass(tx: Sql, job: string): Promise<{ fp: number; finishedAt: number } | null> {
  const rows = await tx<{ fp: number; finishedAt: number }>`
    SELECT (stats->>'fp')::bigint AS fp, finished_at
      FROM job_runs
     WHERE job = ${job} AND status = 'ok' AND finished_at IS NOT NULL AND stats ? 'fp' AND (stats->>'full')::int = 1
     ORDER BY started_at DESC LIMIT 1`;
  const r = rows[0];
  return r ? { fp: Number(r.fp), finishedAt: Number(r.finishedAt) } : null;
}
