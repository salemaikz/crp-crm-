// Документ настроек для прогона до P5: раздел ролей из пресета клиента (или base, когда появится)
// плюс пояс установки. Форма — ConfigV1 (CONFIG §3.2): { rev, global: { org, roles }, spaces }.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_EVENT_TYPE, SEED_TZ } from './seed';

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
 * Синтетика сеет групповое мероприятие видом SEED_EVENT_TYPE. В слое base видов нет (booking.eventTypes = []) —
 * для продукта это нормально, но прогон должен проверять изоляцию, а не отсутствие вида. Поэтому вид
 * дописывается в ревизию настроек ПРОГОНА (presets/base не трогаем), если его там ещё нет.
 * Экран дежурства без вида в каталоге не падает: подпись берёт ключ (см. page.tsx).
 */
export function withSyntheticEventTypes(spaces: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(spaces)) {
    const space = raw as { booking?: { eventTypes?: Array<{ key: string }> } };
    const types = space.booking?.eventTypes;
    if (!space.booking || !Array.isArray(types) || types.some((x) => x.key === SEED_EVENT_TYPE)) {
      out[key] = raw;
      continue;
    }
    const added = { key: SEED_EVENT_TYPE, behavior: 'group', label: { ru: 'Группа' }, short: { ru: 'Гр' }, capacity: 30, durationMin: 180, directions: [] };
    out[key] = { ...space, booking: { ...space.booking, eventTypes: [...types, added] } };
  }
  return out;
}

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
  const spaces = withSyntheticEventTypes(set.spaces as Record<string, unknown>);
  const docs = { global: global as never, spaces: spaces as never };
  const check = validateConfigSet(docs);
  if (!check.ok) throw new Error(`пресет прогона не прошёл проверку: ${check.issues.map((i) => i.path).join(', ')}`);
  resetConfigCache();
  await writeConfig({ docs, presetDocs: docs, source: 'preset', authorId: null, project: true, note: 'прогон изоляции: пресет ЦРП' });
  resetConfigCache();
}
