// Документ настроек для прогона до P5: раздел ролей из пресета клиента (или base, когда появится)
// плюс пояс установки. Форма — ConfigV1 (CONFIG §3.2): { rev, global: { org, roles }, spaces }.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_TZ } from './seed';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Роли слоя пресета: 'clients/crp' → presets/clients/crp/preset.json (без заглушек архивации ролей base). */
export function rolesLayer(preset: string): unknown {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', preset, 'preset.json'), 'utf8')) as { global: { roles: unknown } };
  return (doc.global.roles as Array<Record<string, unknown>>).filter((r) => 'grants' in r);
}

export function configDoc(preset = 'clients/crp', rev = 1): unknown {
  return { rev, global: { org: { timezone: SEED_TZ }, roles: rolesLayer(preset) }, spaces: {} };
}
