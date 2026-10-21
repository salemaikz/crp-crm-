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

/**
 * Пресет прогона: ISOLATION_PRESET=base — прогон на одном базовом пресете (роли lead/manager/observer),
 * по умолчанию — слои ЦРП. Нужен для Q1d: изоляция должна держаться на обоих пресетах.
 */
export const SEED_PRESET = process.env.ISOLATION_PRESET === 'base' ? 'base' : 'clients/crp';

export function configDoc(preset = SEED_PRESET, rev = 1): unknown {
  return { rev, global: { org: { timezone: SEED_TZ }, roles: rolesLayer(preset) }, spaces: {} };
}

/** Слои пресета первого клиента в порядке сборки (CONFIG §5: base → kz → отрасль → накладка клиента). */
export const SEED_LAYERS: readonly string[] =
  SEED_PRESET === 'base' ? ['base', 'kz', 'consulting-sales'] : ['base', 'kz', 'consulting-sales', join(ROOT, 'presets', 'clients', 'crp')];

/**
 * Записать в БД прогона ревизии настроек собранного пресета ЦРП, как `crmctl config apply`: модули
 * домена (клиенты, запись, сделки) читают активные настройки из БД, а не из подмены Viewer. Без этого
 * каждый их маршрут отвечает 500 ConfigMissingError. Пояс — как у синтетики. Вызывать после seed.
 */
export async function applySeedConfig(): Promise<void> {
  const { assembleLayers, validateConfigSet } = await import('../../../packages/core/src/config');
  const { loadLayers } = await import('../../../src/server/platform/config/preset-files');
  const { writeConfig } = await import('../../../src/server/platform/config/write');
  const { resetConfigCache } = await import('../../../src/server/platform/config/active');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const layers = await loadLayers(SEED_LAYERS, join(ROOT, 'presets'));
  const set = assembleLayers(
    layers.map((l) => l.layer),
    { productVersion: pkg.version },
  );
  const global = { ...(set.global as Record<string, unknown>) };
  global.org = { ...(global.org as Record<string, unknown>), timezone: SEED_TZ };
  const docs = { global: global as never, spaces: set.spaces };
  const check = validateConfigSet(docs);
  if (!check.ok) throw new Error(`пресет прогона не прошёл проверку: ${check.issues.map((i) => i.path).join(', ')}`);
  resetConfigCache();
  await writeConfig({ docs, presetDocs: docs, source: 'preset', authorId: null, project: true, note: 'прогон изоляции: пресет ЦРП' });
  resetConfigCache();
}
