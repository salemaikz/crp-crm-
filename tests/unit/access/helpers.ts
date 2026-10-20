// Общие помощники unit-тестов доступа: роли пресета клиента и синтетические роли.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RolesSchema, type RoleConfig } from '../../../packages/core/src/access';

export const PRESET_ROLES_PATH = join(import.meta.dirname, '..', '..', '..', 'presets', 'clients', 'crp', 'roles.json');

/** Роли пресета первого клиента, прошедшие схему и валидатор. */
export function presetRoles(): RoleConfig[] {
  const doc = JSON.parse(readFileSync(PRESET_ROLES_PATH, 'utf8')) as { global: { roles: unknown } };
  return RolesSchema.parse(doc.global.roles);
}

export function presetRole(key: string): RoleConfig {
  const r = presetRoles().find((x) => x.key === key);
  if (!r) throw new Error(`нет роли ${key}`);
  return r;
}

/** Минимальная корректная роль для тестов схемы. */
export function role(over: Partial<RoleConfig> = {}): RoleConfig {
  return {
    key: 'tester',
    label: { ru: 'Тест' },
    readOnly: false,
    grants: [],
    relations: [],
    fieldAccessDefault: 'read',
    menu: [],
    ...over,
  };
}
