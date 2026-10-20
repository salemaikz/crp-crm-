// Роли, которые можно назначить: раздел `global.roles` активной ревизии настроек (без архивных).
import { resolvers } from '@/server/access/context';
import { parseAccessConfig } from '@/server/access/viewer';
import type { RoleOption } from './types';

/** Назначаемые роли в порядке настроек. Подпись — ru: kk пока не включён (D-002). */
export async function assignableRoles(): Promise<RoleOption[]> {
  const cfg = parseAccessConfig(await resolvers().config());
  return cfg.roles.filter((r) => r.archived !== true).map((r) => ({ key: r.key, label: r.label.ru }));
}
