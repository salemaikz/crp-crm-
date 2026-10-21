// Справочные данные экрана отчётов: подписи из настроек (источники, типы услуг, типы событий, причины) и список
// сотрудников для фильтра. Подписи в локали не дублируются: их ведёт установка (`label.ru`).
import { time } from '@crm/core';
import type { Viewer } from '@/server/access';
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb } from '@/server/platform/db';
import { requireSpaceReports } from './access';
import { reportsDeps } from './deps';
import { selectStaff } from './repo';

export interface ReportLabels {
  sources: Record<string, string>;
  serviceTypes: Record<string, string>;
  eventTypes: Record<string, string>;
  /** Группа справочника причин → ключ → подпись. */
  reasons: Record<string, Record<string, string>>;
}

export interface ReportMeta {
  today: string;
  timeZone: string;
  labels: ReportLabels;
  /** Участники раздачи: для фильтра по сотрудникам. */
  staff: { userId: string; name: string }[];
}

type Labeled = { key: string; label: { ru?: string } };
const labelsOf = (list: readonly Labeled[]): Record<string, string> => Object.fromEntries(list.map((x) => [x.key, x.label.ru ?? x.key]));

export async function getReportMeta(viewer: Viewer): Promise<ReportMeta> {
  const spaceId = requireSpaceReports(viewer);
  const deps = reportsDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const timeZone = cfg.distribution.timeZone;
  const today = time.localDayOf(now, timeZone);
  const active = await getActiveConfig();
  const space = Object.values(active.spaces).find((s) => s.spaceId === spaceId)?.doc;
  const reasons: Record<string, Record<string, string>> = {};
  for (const [group, list] of Object.entries(space?.reasons ?? {})) reasons[group] = labelsOf(list as readonly Labeled[]);
  // Источники из настроек плюс виды (`source_kind`) — запасной ключ, когда `source_key` пуст
  const sources = labelsOf(active.global.doc.sources as readonly Labeled[]);
  const staff = await selectStaff((await getDb()).sql, { spaceId, roles: cfg.distribution.participantRoles, today });
  return {
    today,
    timeZone,
    labels: {
      sources,
      serviceTypes: labelsOf((space?.serviceTypes ?? []) as readonly Labeled[]),
      eventTypes: labelsOf((space?.booking.eventTypes ?? []) as readonly Labeled[]),
      reasons,
    },
    staff: staff.map((s) => ({ userId: s.userId, name: s.name })),
  };
}
