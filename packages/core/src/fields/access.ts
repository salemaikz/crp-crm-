// Доступ к полю для роли (CONFIG §6.11, D-121): `access[роль]` → `access['*']` → `fieldAccessDefault`
// роли. `edit` без пишущего разрешения объекта или у архивного поля — `read`. Нет роли — `hidden`.
import type { FieldAccess, FieldDef, FieldObject, FieldRole, FieldViewer } from './types.js';

const RANK: Readonly<Record<FieldAccess, number>> = { hidden: 0, read: 1, edit: 2 };

function own(rec: Readonly<Record<string, FieldAccess>>, key: string): FieldAccess | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Доступ роли по настройкам, без учёта разрешений сотрудника. */
export function configuredAccess(def: FieldDef, roleKey: string, fieldAccessDefault: FieldAccess): FieldAccess {
  return own(def.access, roleKey) ?? own(def.access, '*') ?? fieldAccessDefault;
}

/** Итоговый доступ сотрудника к полю. */
export function resolveAccess(def: FieldDef, viewer: FieldViewer): FieldAccess {
  if (viewer.roleKey === null) return 'hidden';
  const base = configuredAccess(def, viewer.roleKey, viewer.fieldAccessDefault);
  if (base === 'edit' && (!viewer.canEdit || def.archived)) return 'read';
  return base;
}

/** Поля объекта (включая архивные — их значения остаются читаемыми). */
export function fieldsOf(fields: readonly FieldDef[], object: FieldObject): FieldDef[] {
  return fields.filter((f) => f.object === object);
}

/** Карта «ключ → доступ» для полей объекта. */
export function accessMap(fields: readonly FieldDef[], object: FieldObject, viewer: FieldViewer): Map<string, FieldAccess> {
  const out = new Map<string, FieldAccess>();
  for (const f of fieldsOf(fields, object)) out.set(f.key, resolveAccess(f, viewer));
  return out;
}

/** Ключи полей объекта, видимых сотруднику (read или edit). */
export function visibleKeys(fields: readonly FieldDef[], object: FieldObject, viewer: FieldViewer): string[] {
  return fieldsOf(fields, object)
    .filter((f) => resolveAccess(f, viewer) !== 'hidden')
    .map((f) => f.key);
}

/** Ключи полей объекта, скрытых от сотрудника. */
export function hiddenKeys(fields: readonly FieldDef[], object: FieldObject, viewer: FieldViewer): string[] {
  return fieldsOf(fields, object)
    .filter((f) => resolveAccess(f, viewer) === 'hidden')
    .map((f) => f.key);
}

/** Видно ли поле каждой неархивной роли (условие попадания в общий search_norm, D-123). */
export function visibleToAllRoles(def: FieldDef, roles: readonly FieldRole[]): boolean {
  return roles.filter((r) => !r.archived).every((r) => RANK[configuredAccess(def, r.key, r.fieldAccessDefault)] > 0);
}

/**
 * Поле для фильтра списка: есть у объекта, `filterable`, видно сотруднику. Иначе null — маршрут
 * отвечает 400 одинаково для «нет поля» и «скрыто» (ARCHITECTURE §5.2 п. 8).
 */
export function filterableField(fields: readonly FieldDef[], object: FieldObject, viewer: FieldViewer, key: string): FieldDef | null {
  const def = fieldsOf(fields, object).find((f) => f.key === key);
  if (!def || !def.filterable) return null;
  return resolveAccess(def, viewer) === 'hidden' ? null : def;
}
