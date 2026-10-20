// Документ настроек для прогона до P5: раздел ролей из пресета клиента (или base, когда появится)
// плюс пояс установки. Форма — ConfigV1 (CONFIG §3.2): { rev, global: { org, roles }, spaces }.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_TZ } from './seed';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Слой пресета с разделом ролей: 'clients/crp' → presets/clients/crp/roles.json. */
export function rolesLayer(preset: string): unknown {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', preset, 'roles.json'), 'utf8')) as { global: { roles: unknown } };
  return doc.global.roles;
}

export function configDoc(preset = 'clients/crp', rev = 1): unknown {
  return { rev, global: { org: { timezone: SEED_TZ }, roles: rolesLayer(preset) }, spaces: {} };
}
