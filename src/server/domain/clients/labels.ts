// Подписи справочников настроек для карточки клиента: этапы воронок, виды услуг, виды мероприятий, отделы.
// Нужны интерфейсу для истории сделок и итогового отчёта (сервер отдаёт ключи, подписи — из активной ревизии).
import type { Viewer } from '@/server/access';
import { calling } from '@crm/core';
import { parseBoardSettings } from '@/server/domain/cards/boardSettings';
import { getActiveConfig } from '@/server/platform/config/active';

type Label = { ru: string; kk?: string };

export type CatalogLabels = {
  /** `воронка:этап`. */
  stages: Record<string, Label>;
  pipelines: Record<string, Label>;
  serviceTypes: Record<string, Label>;
  eventTypes: Record<string, Label>;
  teams: Record<string, Label>;
};

const label = (v: unknown, fallback: string): Label => {
  const o = (v ?? {}) as { ru?: unknown; kk?: unknown };
  return { ru: typeof o.ru === 'string' && o.ru ? o.ru : fallback, ...(typeof o.kk === 'string' && o.kk ? { kk: o.kk } : {}) };
};

type Item = { key: string; label?: unknown };

export async function loadCatalogLabels(viewer: Viewer): Promise<CatalogLabels> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const doc = (space?.doc ?? {}) as unknown as {
    pipelines?: Array<Item & { stages?: Item[] }>;
    serviceTypes?: Item[];
    teams?: Item[];
    booking?: { eventTypes?: Item[] };
  };
  const out: CatalogLabels = { stages: {}, pipelines: {}, serviceTypes: {}, eventTypes: {}, teams: {} };
  for (const p of doc.pipelines ?? []) {
    out.pipelines[p.key] = label(p.label, p.key);
    for (const st of p.stages ?? []) out.stages[`${p.key}:${st.key}`] = label(st.label, st.key);
  }
  for (const x of doc.serviceTypes ?? []) out.serviceTypes[x.key] = label(x.label, x.key);
  for (const x of doc.teams ?? []) out.teams[x.key] = label(x.label, x.key);
  for (const x of doc.booking?.eventTypes ?? []) out.eventTypes[x.key] = label(x.label, x.key);
  return out;
}

/** Подписи для событий ленты из настроек (простые строки: уходят в клиентский компонент). */
export type FeedCatalog = {
  /** Итог звонка: `ключ итога` → подпись. */
  outcomes: Record<string, string>;
  /** Причина итога: `ключ итога:ключ причины` → подпись (причины берутся из группы итога). */
  reasons: Record<string, string>;
  /** Вид мероприятия → короткая подпись. */
  events: Record<string, string>;
  /** Этап сделки (ключ этапа без воронки; при совпадении ключей побеждает первая воронка) → подпись. */
  stages: Record<string, string>;
  /** Состояние карточки → подпись колонки доски, в которой оно вычисляется (пусто — пресета доски нет). */
  columns: Record<string, string>;
};

/** Подписи итогов, причин, видов мероприятий, этапов и колонок пространства зрителя (активная ревизия настроек). */
export async function loadFeedCatalog(viewer: Viewer): Promise<FeedCatalog> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const out: FeedCatalog = { outcomes: {}, reasons: {}, events: {}, stages: {}, columns: {} };
  if (!space) return out;
  const doc = space.doc as unknown as {
    calling?: { outcomes?: Array<Item & { reasonGroup?: string | null }> };
    reasons?: Record<string, Item[] | undefined>;
    pipelines?: Array<Item & { stages?: Item[] }>;
    booking?: { eventTypes?: Array<Item & { short?: unknown }> };
  };
  for (const o of doc.calling?.outcomes ?? []) {
    out.outcomes[o.key] = label(o.label, o.key).ru;
    for (const r of (o.reasonGroup ? doc.reasons?.[o.reasonGroup] : undefined) ?? []) out.reasons[`${o.key}:${r.key}`] = label(r.label, r.key).ru;
  }
  for (const e of doc.booking?.eventTypes ?? []) out.events[e.key] = label(e.short ?? e.label, e.key).ru;
  for (const p of doc.pipelines ?? []) for (const st of p.stages ?? []) out.stages[st.key] ??= label(st.label, st.key).ru;
  const board = parseBoardSettings(doc);
  for (const state of calling.CARD_STATES) {
    const key = calling.columnOf({ state, holdReason: '', ownerUserId: 'x', attempts: 0, closedAt: null }, null, board.spec);
    const text = board.columns.find((c) => c.key === key)?.label;
    if (text) out.columns[state] = text;
  }
  return out;
}
