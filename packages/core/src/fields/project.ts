// projectFor — что сервер отдаёт о полях объекта этому сотруднику (ARCHITECTURE §2.2, §5.2 п. 8).
// Скрытые поля и значения ключей, которых нет в настройках, не покидают сервер: ни в ответе, ни в
// ленте («было → стало»), ни в фильтре. Ссылки и почта перепроверяются при выводе (D-051).
import { fieldsOf, resolveAccess } from './access.js';
import { mailtoHref, safeHttpUrl } from './values.js';
import type { CustomValues, FieldDef, FieldLabel, FieldObject, FieldType, FieldValue, FieldViewer } from './types.js';

export interface ProjectedOption {
  key: string;
  label: FieldLabel;
  /** Архивный вариант виден, только если он выбран; выбрать его заново нельзя. */
  archived: boolean;
}

export interface ProjectedField {
  key: string;
  type: FieldType;
  label: FieldLabel;
  access: 'edit' | 'read';
  options: ProjectedOption[];
  value: FieldValue | null;
  /** Готовая безопасная ссылка для `url` и `email` (иначе null): интерфейс не строит href сам. */
  href: string | null;
  showOn: FieldDef['showOn'];
  archived: boolean;
}

export interface Projection {
  fields: ProjectedField[];
  /** Только видимые значения: то, что можно класть в ответ API. */
  values: Record<string, FieldValue>;
}

function hrefOf(type: FieldType, value: FieldValue | null): string | null {
  if (typeof value !== 'string') return null;
  if (type === 'url') return safeHttpUrl(value);
  if (type === 'email') return mailtoHref(value);
  return null;
}

/**
 * Проекция полей объекта. Архивное поле без значения не показывается; с значением — только чтение.
 * Порядок — порядок полей в настройках.
 */
export function projectFor(viewer: FieldViewer, object: FieldObject, fields: readonly FieldDef[], values: CustomValues): Projection {
  const out: ProjectedField[] = [];
  const vis: Record<string, FieldValue> = {};
  for (const def of fieldsOf(fields, object)) {
    const access = resolveAccess(def, viewer);
    if (access === 'hidden') continue;
    const value = Object.hasOwn(values, def.key) ? values[def.key]! : null;
    if (def.archived && value === null) continue;
    const chosen = new Set(Array.isArray(value) ? value : typeof value === 'string' ? [value] : []);
    out.push({
      key: def.key,
      type: def.type,
      label: def.label,
      access,
      options: def.options.filter((o) => !o.archived || chosen.has(o.key)).map((o) => ({ key: o.key, label: o.label, archived: !!o.archived })),
      value,
      href: hrefOf(def.type, value),
      showOn: def.showOn,
      archived: !!def.archived,
    });
    if (value !== null) vis[def.key] = value;
  }
  return { fields: out, values: vis };
}

/** Только видимые значения (списки, выгрузки): без описаний полей. */
export function projectValues(viewer: FieldViewer, object: FieldObject, fields: readonly FieldDef[], values: CustomValues): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const def of fieldsOf(fields, object)) {
    if (!Object.hasOwn(values, def.key) || resolveAccess(def, viewer) === 'hidden') continue;
    out[def.key] = values[def.key]!;
  }
  return out;
}

/** Событие ленты «поле было → стало» (`data` события `field.changed`, D-125). */
export interface FieldChangedData {
  obj: FieldObject;
  /** true — системное поле (колонка): видно всем, кто видит объект. */
  sys: boolean;
  field: string;
  before: FieldValue | null;
  after: FieldValue | null;
  /** Для контакта — его id. */
  contactId?: string;
}

/**
 * Можно ли показать событие изменения поля. Неизвестное или скрытое поле — нет (PROCESS 9.1:
 * событие скрытого поля скрыто целиком). Второй рубеж после фильтра в SQL.
 */
export function canSeeFieldChange(viewer: FieldViewer, fields: readonly FieldDef[], data: Pick<FieldChangedData, 'obj' | 'sys' | 'field'>): boolean {
  if (data.sys) return viewer.roleKey !== null;
  const def = fieldsOf(fields, data.obj).find((f) => f.key === data.field);
  return !!def && resolveAccess(def, viewer) !== 'hidden';
}

/**
 * Белый список `obj:key` видимых полей настроек — параметр SQL-фильтра ленты: событие `field.changed`
 * несистемного поля проходит, только если его `obj:field` в списке.
 */
export function visibleFieldRefs(viewer: FieldViewer, fields: readonly FieldDef[]): string[] {
  return fields.filter((f) => resolveAccess(f, viewer) !== 'hidden').map((f) => `${f.object}:${f.key}`);
}
