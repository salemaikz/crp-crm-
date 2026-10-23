// Настройки доски и горячести пространства: `board.*` и `queue.heat` (docs/pipeline-v2-design.md §2.2, §5.3, §6.5).
// Свой Zod поверх активных настроек (набор уже проверен целиком, здесь берётся только нужный срез).
// Нет ключа `board` — колонки совпадают с состояниями; нет `queue.heat` — все веса нули (горячесть 0).
import { calling } from '@crm/core';
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';

const STATES = calling.CARD_STATES;

const Column = z
  .object({
    key: z.string().min(1),
    label: z.object({ ru: z.string() }).passthrough(),
    states: z.array(z.enum(STATES)).min(1),
    eventTypes: z.array(z.string()).optional(),
    recentDays: z.number().int().min(1).optional(),
    drop: z.array(z.object({ kind: z.string(), reason: z.string() }).passthrough()).optional(),
    dropMore: z.boolean().optional(),
  })
  .passthrough();

const Slice = z
  .object({
    board: z
      .object({
        columns: z.array(Column).min(1),
        agreedFallback: z.string().optional(),
        tones: z.array(z.object({ when: z.string(), tone: z.string() }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
    queue: z
      .object({
        heat: z
          .object({
            states: z.record(z.string(), z.number()),
            reasons: z.record(z.string(), z.number()),
            flags: z.object({ attendedGroup: z.number(), attendedIndividual: z.number(), noShow: z.number(), purchased: z.number(), lprYes: z.number() }).passthrough(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    calling: z.object({ callbackReason: z.object({ required: z.boolean() }).passthrough().optional() }).passthrough().optional(),
  })
  .passthrough();

export interface BoardColumnInfo {
  key: string;
  /** Подпись из пресета; null — пресет доски не задан (интерфейс берёт подпись состояния из локали). */
  label: string | null;
  def: calling.BoardColumnDef;
}

export interface BoardSettings {
  spec: calling.BoardSpec;
  columns: readonly BoardColumnInfo[];
  tones: readonly { when: string; tone: string }[];
  /** Веса горячести; без `queue.heat` — нули. */
  heat: calling.HeatWeights;
  /** Задан ли `queue.heat` (иначе горячесть всегда 0 и сортировка идёт по сроку). */
  hasHeat: boolean;
}

const ZERO_HEAT: calling.HeatWeights = { states: {}, reasons: {}, flags: { attendedGroup: 0, attendedIndividual: 0, noShow: 0, purchased: 0, lprYes: 0 } };

/** Чистый разбор документа пространства. Не прошёл схему — доска по умолчанию (колонки = состояния). */
export function parseBoardSettings(doc: unknown): BoardSettings {
  const p = Slice.safeParse(doc);
  const d = p.success ? p.data : {};
  const board = d.board;
  const heat = d.queue?.heat;
  const defs: calling.BoardColumnDef[] = board
    ? board.columns.map((c) => ({
        key: c.key,
        states: c.states,
        ...(c.eventTypes !== undefined ? { eventTypes: c.eventTypes } : {}),
        ...(c.recentDays !== undefined ? { recentDays: c.recentDays } : {}),
        ...(c.drop !== undefined ? { drop: c.drop.map((x) => ({ kind: x.kind, reason: x.reason })) } : {}),
        ...(c.dropMore !== undefined ? { dropMore: c.dropMore } : {}),
      }))
    : STATES.map((s) => ({ key: s, states: [s] }));
  const labels = new Map((board?.columns ?? []).map((c) => [c.key, c.label.ru]));
  return {
    spec: { columns: defs, ...(board?.agreedFallback !== undefined ? { agreedFallback: board.agreedFallback } : {}) },
    columns: defs.map((def) => ({ key: def.key, label: labels.get(def.key) ?? null, def })),
    tones: board?.tones?.map((t) => ({ when: t.when, tone: t.tone })) ?? [],
    heat: heat
      ? {
          states: Object.fromEntries(Object.entries(heat.states).filter(([k]) => (STATES as readonly string[]).includes(k))) as calling.HeatWeights['states'],
          reasons: heat.reasons,
          flags: { attendedGroup: heat.flags.attendedGroup, attendedIndividual: heat.flags.attendedIndividual, noShow: heat.flags.noShow, purchased: heat.flags.purchased, lprYes: heat.flags.lprYes },
        }
      : ZERO_HEAT,
    hasHeat: heat !== undefined,
  };
}

const cache = new WeakMap<object, BoardSettings>();

/** Настройки доски пространства из активной ревизии (разбор кэшируется по объекту документа). */
export async function loadBoardSettings(spaceId: string): Promise<BoardSettings> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((x) => x.spaceId === spaceId);
  if (!space) return parseBoardSettings({});
  const doc = space.doc as unknown as object;
  let hit = cache.get(doc);
  if (!hit) {
    hit = parseBoardSettings(doc);
    cache.set(doc, hit);
  }
  return hit;
}

/** Отпечаток весов и порядка колонок: задание пересчёта сравнивает его с прошлым прогоном (32-битное целое). */
export function heatFingerprint(s: BoardSettings): number {
  const text = JSON.stringify([s.heat.states, s.heat.reasons, s.heat.flags]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
