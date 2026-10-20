// Настройки, нужные клиентам: поля (global + пространство), роли для доступа к полям, формы
// собственности, правила номеров, лимит проверок номера. Читается из активной ревизии (CONFIG §6).
import { fields, names, type phone } from '@crm/core';
import type { Viewer } from '@/server/access';
import { can } from '@/server/access';
import { getActiveConfig } from '@/server/platform/config/active';

export type ClientsConfig = {
  rev: number;
  /** Поля клиента, контакта (global) и объектов пространства. */
  fields: fields.FieldDef[];
  roles: fields.FieldRole[];
  legalForms: fields.LegalFormRef[];
  /** Формы собственности с подписями (выбор в форме, шапка). */
  legalFormOptions: Array<{ key: string; label: { ru: string; kk?: string }; archived: boolean }>;
  namesForms: names.LegalForm[];
  phoneRules: phone.PhoneRules;
  probesPerDay: number;
  /** Ключи полей клиента, значения которых входят в search_norm (видны всем ролям). */
  searchable: string[];
};

const ACCESS = new Set(['edit', 'read', 'hidden']);

function accessOf(v: unknown): fields.FieldAccess {
  return typeof v === 'string' && ACCESS.has(v) ? (v as fields.FieldAccess) : 'hidden';
}

/** Роль из раздела ролей настроек: ключ, доступ к полям по умолчанию, архив. */
function roleOf(r: Record<string, unknown>): fields.FieldRole {
  return { key: String(r.key), fieldAccessDefault: accessOf(r.fieldAccessDefault), archived: r.archived === true };
}

export async function loadClientsConfig(viewer: Viewer): Promise<ClientsConfig> {
  const cfg = await getActiveConfig();
  const g = cfg.global.doc;
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const defs = [...g.fields, ...(space?.doc.fields ?? [])] as unknown as fields.FieldDef[];
  const roles = (g.roles as unknown as Record<string, unknown>[]).map(roleOf);
  const legal = g.org.legalForms;
  return {
    rev: cfg.global.rev,
    fields: defs,
    roles,
    legalForms: legal.map((f) => ({ key: f.key, idIsPersonal: f.idIsPersonal, archived: f.archived === true })),
    legalFormOptions: legal.map((f) => ({ key: f.key, label: f.label, archived: f.archived === true })),
    namesForms: names.legalFormsFromConfig(legal),
    phoneRules: g.phone,
    probesPerDay: g.security.phoneProbesPerDay,
    searchable: fields.searchableKeys(defs, roles),
  };
}

/**
 * Кто смотрит на поля. Нет роли в настройках — ничего не видно (fail closed). `canEdit`: пишущее
 * разрешение и роль не «только чтение»; без него `edit` из настроек понижается до `read`.
 */
export function fieldViewer(viewer: Viewer, cfg: ClientsConfig): fields.FieldViewer {
  const role = cfg.roles.find((r) => r.key === viewer.roleKey && !r.archived);
  if (!role) return { roleKey: null, fieldAccessDefault: 'hidden', canEdit: false };
  return { roleKey: role.key, fieldAccessDefault: role.fieldAccessDefault, canEdit: !viewer.readOnly && can(viewer, 'client.edit') };
}
