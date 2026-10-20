// Настройки уведомлений пространства: роли получателей из global.roles, `notifications.*`, `tasks.overdueAlertMinutes`.
// Свой Zod поверх активных настроек: набор уже проверен целиком, здесь берётся только нужный срез.
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';
import type { LoadNotifyConfig, NotifyConfig } from './types';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const GlobalSlice = z
  .object({
    roles: z.array(
      z
        .object({
          key: z.string().min(1),
          archived: z.boolean().optional(),
          grants: z.array(z.object({ perm: z.string() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const SpaceSlice = z
  .object({
    notifications: z.object({ morningDigestAt: Hhmm.nullable() }).passthrough(),
    tasks: z.object({ overdueAlertMinutes: z.number().int().min(1) }).passthrough(),
  })
  .passthrough();

const DigestSlice = z.object({ notifications: z.object({ morningDigestAt: Hhmm.nullable() }).passthrough() }).passthrough();

/** Слайс для расписания сводки: нет документа или он сломан — сводки нет. */
export function morningDigestAt(space: unknown): string | null {
  const p = DigestSlice.safeParse(space);
  return p.success ? p.data.notifications.morningDigestAt : null;
}

/** Чистый разбор. Ошибка схемы — исключение: тихо не слать тревоги лучше, чем слать по угаданным ролям. */
export function parseNotifyConfig(input: { spaceId: string; global: unknown; space: unknown }): NotifyConfig {
  const g = GlobalSlice.parse(input.global);
  const s = SpaceSlice.parse(input.space);
  const live = g.roles.filter((r) => !r.archived);
  const has = (r: (typeof live)[number], perm: string) => r.grants.some((x) => x.perm === perm);
  const managerRoles = live.filter((r) => has(r, 'pool.read')).map((r) => r.key);
  const operatorRoles = live.filter((r) => !has(r, 'pool.read') && has(r, 'card.outcome')).map((r) => r.key);
  return {
    spaceId: input.spaceId,
    managerRoles,
    operatorRoles,
    morningDigestAt: s.notifications.morningDigestAt,
    overdueAlertMinutes: s.tasks.overdueAlertMinutes,
  };
}

const cache = new WeakMap<object, Map<string, NotifyConfig>>();

export const loadNotifyConfig: LoadNotifyConfig = async (spaceId) => {
  const cfg = await getActiveConfig();
  let bySpace = cache.get(cfg);
  if (!bySpace) {
    bySpace = new Map();
    cache.set(cfg, bySpace);
  }
  const hit = bySpace.get(spaceId);
  if (hit) return hit;
  const space = Object.values(cfg.spaces).find((x) => x.spaceId === spaceId);
  if (!space) throw new Error('notify: пространство не найдено в настройках');
  const parsed = parseNotifyConfig({ spaceId, global: cfg.global.doc, space: space.doc });
  bySpace.set(spaceId, parsed);
  return parsed;
};
