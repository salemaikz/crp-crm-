// Воронки пространства из настроек (CONFIG §6.8): то, что нужно записи и эффектам сделок.
// Свой Zod поверх активных настроек: набор уже проверен целиком, здесь берётся только нужный срез.
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';
import type { DealStages } from '@/server/domain/booking/types';

const Stage = z
  .object({
    key: z.string().min(1),
    kind: z.enum(['open', 'won', 'lost']),
    order: z.number().int(),
    auto: z.enum(['on_agreed', 'on_attended']).nullable(),
    label: z.object({ ru: z.string(), kk: z.string().optional() }).passthrough().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

const Pipeline = z
  .object({
    key: z.string().min(1),
    createDealOn: z.enum(['agreed', 'client_created', 'manual']),
    stages: z.array(Stage),
    archived: z.boolean().optional(),
  })
  .passthrough();

export const PipelinesSchema = z.array(Pipeline);

export interface PipelineStage {
  key: string;
  kind: 'open' | 'won' | 'lost';
  order: number;
  auto: 'on_agreed' | 'on_attended' | null;
  /** Подпись из настроек; у минимальных воронок (тесты) её нет. */
  label?: { ru: string; kk?: string };
}

export interface PipelineInfo {
  key: string;
  createDealOn: 'agreed' | 'client_created' | 'manual';
  /** Только действующие этапы (без архивных), в порядке `order`. */
  stages: PipelineStage[];
}

/** Воронки из раздела `pipelines` документа пространства; архивные воронки и этапы отбрасываются. */
export function parsePipelines(raw: unknown): PipelineInfo[] {
  return PipelinesSchema.parse(raw)
    .filter((p) => !p.archived)
    .map((p) => ({
      key: p.key,
      createDealOn: p.createDealOn,
      stages: p.stages
        .filter((s) => !s.archived)
        .map((s) => ({ key: s.key, kind: s.kind, order: s.order, auto: s.auto, ...(s.label ? { label: { ru: s.label.ru, ...(s.label.kk !== undefined ? { kk: s.label.kk } : {}) } } : {}) }))
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    }));
}

/**
 * Воронка, где запись создаёт сделку: `createDealOn = agreed` и есть этап `auto = on_agreed`.
 * Нет такой — записи сделку не создают (`null`).
 */
export function bookingPipeline(pipelines: readonly PipelineInfo[]): PipelineInfo | null {
  return pipelines.find((p) => p.createDealOn === 'agreed' && p.stages.some((s) => s.auto === 'on_agreed')) ?? null;
}

export function toDealStages(p: PipelineInfo): DealStages {
  return {
    pipelineKey: p.key,
    onAgreedStageKey: p.stages.find((s) => s.auto === 'on_agreed')?.key ?? null,
    onAttendedStageKey: p.stages.find((s) => s.auto === 'on_attended')?.key ?? null,
  };
}

/** Воронки пространства. Подменяется в тестах. */
export type PipelineResolver = (spaceId: string) => Promise<PipelineInfo[]>;

/** Настоящий источник: активные настройки. */
export const configPipelineResolver: PipelineResolver = async (spaceId) => {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === spaceId);
  if (!space) return [];
  return parsePipelines((space.doc as unknown as { pipelines?: unknown }).pipelines ?? []);
};
