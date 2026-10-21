// Меню зрителя: роль берётся из активных настроек (menu), права — из Viewer, флаги — из окружения.
// Серверный модуль; чистый расчёт — в menu.ts.
import { can, type Viewer } from '@/server/access';
import { canSpaceReports } from '@/server/domain/reports';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { FEATURES, isFeatureEnabled } from '@/server/platform/flags';
import { buildMenu, shellKindOf, type BuiltMenu, type ShellKind } from './menu';

/** Ключи меню роли зрителя из настроек; нет роли или настроек — пусто. */
export async function roleMenuOf(viewer: Viewer): Promise<readonly string[]> {
  if (!viewer.roleKey) return [];
  const config = await getActiveConfigOrNull();
  return config?.global.roles.find((r) => r.key === viewer.roleKey)?.menu ?? [];
}

export function enabledFeatures(): ReadonlySet<string> {
  return new Set(FEATURES.filter((f) => isFeatureEnabled(f)));
}

/** Оболочка и пункты зрителя. `force` — оболочка, заданная группой маршрутов (дежурный). */
export async function loadMenu(viewer: Viewer, force?: ShellKind): Promise<BuiltMenu> {
  const menu = await roleMenuOf(viewer);
  return buildMenu({
    shell: force ?? shellKindOf(menu),
    menu,
    can: (perm) => can(viewer, perm),
    spaceReports: canSpaceReports(viewer),
    isAdmin: viewer.isAdmin,
    features: enabledFeatures(),
  });
}
