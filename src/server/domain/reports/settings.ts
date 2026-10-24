// Настройки сводки: срез раздачи (через домен раздачи) плюс `tasks.overdueAlertMinutes` и `reports.callsPerHourTarget`
// (CONFIG §6.12). Набор настроек уже проверен целиком; здесь берётся только нужное, с безопасными значениями по умолчанию.
import { z } from 'zod';
import { loadDistributionConfig } from '@/server/domain/distribution';
import { parseBoardSettings } from '@/server/domain/cards/boardSettings';
import { getActiveConfig, getActiveConfigOrNull } from '@/server/platform/config/active';
import { reasonColumns, type ReasonColumn } from './reasons';
import type { ReportsConfig } from './types';

const DEFAULT_OVERDUE_MINUTES = 60;

const SpaceSlice = z
  .object({
    tasks: z.object({ overdueAlertMinutes: z.number().int().min(1).optional() }).passthrough().optional(),
    reports: z.object({ callsPerHourTarget: z.number().int().min(1).nullable().optional() }).passthrough().optional(),
  })
  .passthrough();

/** Чистый разбор документа пространства: порог просрочки и норма звонков в час. */
export function parseReportsSlice(space: unknown): { overdueAlertMinutes: number; callsPerHourTarget: number | null } {
  const parsed = SpaceSlice.safeParse(space);
  const data = parsed.success ? parsed.data : {};
  return {
    overdueAlertMinutes: data.tasks?.overdueAlertMinutes ?? DEFAULT_OVERDUE_MINUTES,
    callsPerHourTarget: data.reports?.callsPerHourTarget ?? null,
  };
}

export async function loadReportsConfig(spaceId: string, now: number): Promise<ReportsConfig> {
  const distribution = await loadDistributionConfig(spaceId, now);
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === spaceId);
  return { distribution, ...parseReportsSlice(space?.doc) };
}

/** Колонки доски ролей «мусор» и «перезвон» из настроек пространства; настроек нет — пусто (остаются прежние группы). */
export async function loadReasonColumns(spaceId: string): Promise<ReasonColumn[]> {
  const active = await getActiveConfigOrNull();
  const space = Object.values(active?.spaces ?? {}).find((s) => s.spaceId === spaceId);
  if (!space) return [];
  return reasonColumns(parseBoardSettings(space.doc).columns.map((c) => ({ key: c.key, label: c.label, states: c.def.states })));
}
