// Подписи справочников настроек для карточки клиента: этапы воронок, виды услуг, виды мероприятий, отделы.
// Нужны интерфейсу для истории сделок и итогового отчёта (сервер отдаёт ключи, подписи — из активной ревизии).
import type { Viewer } from '@/server/access';
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
