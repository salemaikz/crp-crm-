// Действующие права роли: охваты разрешений и отношения с суженным списком действий.
// Чистые функции: из них строится Viewer (src/server/access/viewer.ts) и матрица прав в тестах.
import { isWritePermission, type Permission, type Scope } from './catalog';
import { RELATIONS, type ConsultantWindow, type RelationKey } from './relations';
import type { RoleConfig } from './roles';

/** Отношение в действии: что оно даёт читать и делать этой роли. */
export type ActiveRelation =
  | { key: 'booked_with_me'; params: ConsultantWindow; reads: readonly Permission[]; actions: readonly Permission[] }
  | { key: Exclude<RelationKey, 'booked_with_me'>; params: Record<string, never>; reads: readonly Permission[]; actions: readonly Permission[] };

/** Охваты разрешений роли. Архивная роль ничего не даёт; «только чтение» не даёт пишущих. */
export function roleGrants(role: RoleConfig): Map<Permission, Scope> {
  const out = new Map<Permission, Scope>();
  if (role.archived) return out;
  for (const g of role.grants) {
    if (role.readOnly && isWritePermission(g.perm)) continue; // валидатор не пропустит, но второй рубеж
    out.set(g.perm, g.scope);
  }
  return out;
}

/** Отношения роли. Действия — пересечение настроек со списком из кода (пресет может только сузить). */
export function roleRelations(role: RoleConfig): ActiveRelation[] {
  if (role.archived) return [];
  return role.relations.map((r) => {
    const spec = RELATIONS[r.key];
    const actions = role.readOnly ? [] : spec.actions.filter((a) => r.actions.includes(a));
    if (r.key === 'booked_with_me') return { key: r.key, params: { ...r.params }, reads: spec.reads, actions };
    return { key: r.key, params: {}, reads: spec.reads, actions };
  });
}

/** Через какие отношения доступно разрешение: чтение — по `reads`, действие — по `actions`. */
export function relationsProviding(relations: readonly ActiveRelation[], perm: Permission): ActiveRelation[] {
  return relations.filter((r) => r.reads.includes(perm) || r.actions.includes(perm));
}

export type EffectiveAccess = { scope: Scope | null; relations: RelationKey[] };

/** Итог для разрешения: охват роли и отношения, которые его дают. Пусто — нет доступа. */
export function effectiveAccess(
  grants: ReadonlyMap<Permission, Scope>,
  relations: readonly ActiveRelation[],
  perm: Permission,
): EffectiveAccess {
  return { scope: grants.get(perm) ?? null, relations: relationsProviding(relations, perm).map((r) => r.key) };
}

export function hasAccess(grants: ReadonlyMap<Permission, Scope>, relations: readonly ActiveRelation[], perm: Permission): boolean {
  const a = effectiveAccess(grants, relations, perm);
  return a.scope !== null || a.relations.length > 0;
}
