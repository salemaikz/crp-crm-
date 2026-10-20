// Общие помощники тестов настроек: загрузка слоёв пресета и заглушка ролей накладки.
// Раздел ролей (grants) делает P4a; здесь только ключи, на которые ссылаются остальные разделы.
import path from 'node:path';
import { assembleLayers, parseLayer, validateConfigSet, type JsonObject, type PresetLayer } from '@crm/core/config';
import { readFileSync } from 'node:fs';
import { ROOT } from '../../helpers/sourceFiles';

export const PRESETS = path.join(ROOT, 'presets');

export const LAYER_FILES = {
  base: 'base/preset.json',
  kz: 'kz/preset.json',
  'consulting-sales': 'consulting-sales/preset.json',
  crp: 'clients/crp/preset.json',
} as const;

export function loadLayer(key: keyof typeof LAYER_FILES): PresetLayer {
  const file = path.join(PRESETS, LAYER_FILES[key]);
  return parseLayer(JSON.parse(readFileSync(file, 'utf8')), file);
}

/** Роли накладки ЦРП (только key/label): до влития P4a, который задаёт grants. */
export function crpRolesStub(): PresetLayer {
  const roles = ['operator:Оператор', 'rop:РОП', 'consultant:Консультант', 'director:Директор', 'marketing_head:Глава маркетинга', 'marketer:Маркетолог'].map((s) => {
    const [key, ru] = s.split(':') as [string, string];
    return { key, label: { ru } } as JsonObject;
  });
  return parseLayer({ meta: { key: 'crp-roles', version: '0.0.1', schemaVersion: 1, extends: ['base', 'kz', 'consulting-sales', 'crp'] }, global: { roles } });
}

export const PRODUCT = '0.1.0';

export function assembleChain(keys: (keyof typeof LAYER_FILES)[], withRoles = false) {
  const layers = keys.map(loadLayer);
  if (withRoles) layers.push(crpRolesStub());
  return assembleLayers(layers, { productVersion: PRODUCT });
}

export function validChain(keys: (keyof typeof LAYER_FILES)[], withRoles = false) {
  const a = assembleChain(keys, withRoles);
  return validateConfigSet({ global: a.global, spaces: a.spaces });
}
