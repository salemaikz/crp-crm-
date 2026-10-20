// Общие помощники тестов настроек: загрузка слоёв пресета и сборка цепочек.
import path from 'node:path';
import { assembleLayers, parseLayer, validateConfigSet, type PresetLayer } from '@crm/core/config';
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

export const PRODUCT = '0.1.0';

export function assembleChain(keys: (keyof typeof LAYER_FILES)[]) {
  const layers = keys.map(loadLayer);
  return assembleLayers(layers, { productVersion: PRODUCT });
}

export function validChain(keys: (keyof typeof LAYER_FILES)[]) {
  const a = assembleChain(keys);
  return validateConfigSet({ global: a.global, spaces: a.spaces });
}
