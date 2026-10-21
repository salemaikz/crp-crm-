// Настройки и часы досок (B8). Воронки — из активной ревизии настроек пространства (CONFIG §6.8) с полной формой этапа:
// `requires` и `staleDays` нужны доске для «чего не хватает». Подмена — только в тестах.
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';
import { isProduction } from '@/server/platform/env';
import type { DealPipelineInfo } from './types';

const Label = z.object({ ru: z.string(), kk: z.string().optional() }).passthrough();

const Stage = z
  .object({
    key: z.string().min(1),
    label: Label,
    kind: z.enum(['open', 'won', 'lost']),
    order: z.number().int(),
    requires: z
      .object({
        fields: z.array(z.string()),
        booking: z.boolean(),
        attendance: z.boolean(),
        nextTask: z.boolean(),
        amount: z.boolean(),
        serviceType: z.boolean(),
        reason: z.boolean(),
      })
      .passthrough(),
    staleDays: z.number().int().nullable(),
    auto: z.enum(['on_agreed', 'on_attended']).nullable(),
    archived: z.boolean().optional(),
  })
  .passthrough();

const Pipeline = z
  .object({
    key: z.string().min(1),
    label: Label,
    createDealOn: z.enum(['agreed', 'client_created', 'manual']),
    stages: z.array(Stage),
    archived: z.boolean().optional(),
  })
  .passthrough();

/** Воронки документа пространства: без архивных воронок и этапов, этапы по `order`. */
export function parseBoardPipelines(raw: unknown): DealPipelineInfo[] {
  return z
    .array(Pipeline)
    .parse(raw)
    .filter((p) => !p.archived)
    .map((p) => ({
      key: p.key,
      label: p.label.kk === undefined ? { ru: p.label.ru } : { ru: p.label.ru, kk: p.label.kk },
      createDealOn: p.createDealOn,
      stages: p.stages
        .filter((s) => !s.archived)
        .map((s) => ({
          key: s.key,
          label: s.label.kk === undefined ? { ru: s.label.ru } : { ru: s.label.ru, kk: s.label.kk },
          kind: s.kind,
          order: s.order,
          requires: {
            fields: s.requires.fields,
            booking: s.requires.booking,
            attendance: s.requires.attendance,
            nextTask: s.requires.nextTask,
            amount: s.requires.amount,
            serviceType: s.requires.serviceType,
            reason: s.requires.reason,
          },
          staleDays: s.staleDays,
          auto: s.auto,
        }))
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    }));
}

export interface BoardDeps {
  pipelines: (spaceId: string) => Promise<DealPipelineInfo[]>;
  now: () => number;
  /** Пояс установки (D-244: «залежалась» — местные сутки). Не задан — UTC. */
  timeZone?: () => Promise<string>;
}

const fromConfig: BoardDeps['pipelines'] = async (spaceId) => {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === spaceId);
  if (!space) return [];
  return parseBoardPipelines((space.doc as unknown as { pipelines?: unknown }).pipelines ?? []);
};

const tzFromConfig = async (): Promise<string> => {
  const org = (await getActiveConfig()).global.doc as unknown as { org?: { timezone?: unknown } };
  return typeof org.org?.timezone === 'string' ? org.org.timezone : 'UTC';
};

let override: BoardDeps | null = null;

export function boardDeps(): BoardDeps {
  return override ?? { pipelines: fromConfig, now: () => Date.now(), timeZone: tzFromConfig };
}

/** Только тесты: подставить воронки и часы. В production — ошибка. */
export function overrideBoardDepsForTests(deps: BoardDeps | null): void {
  if (isProduction()) throw new Error('deals: подмена зависимостей досок запрещена в production');
  override = deps;
}
