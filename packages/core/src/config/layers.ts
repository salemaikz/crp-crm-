// Слои пресета (CONFIG §3, D-061, D-081): base → kz → отраслевой → накладка клиента.
// Файл слоя:
//   { meta: { key, version, schemaVersion, extends?, requires? },
//     global?: частичный GlobalConfigV1,
//     spaceDefaults?: частичный SpaceConfigV1 — для каждого пространства,
//     spaces?: { <ключ пространства>: частичный SpaceConfigV1 } }
// Документ пространства K = слияние по слоям по порядку: в каждом слое сначала `spaceDefaults`,
// потом `spaces.K`. Проверка схемой — только у собранного набора: слой сам по себе неполный.
import { z } from 'zod';
import { assertJson, isPlainObject, type Json, type JsonObject } from './json.js';
import { mergeJson } from './merge.js';
import { Key } from './schema/primitives.js';
import { CONFIG_SCHEMA_VERSION, migrateDoc } from './version.js';

const LayerKey = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'ключ слоя: ^[a-z][a-z0-9-]{1,39}$');
const SemVer = /^(\d+)\.(\d+)\.(\d+)$/;

export const PresetMeta = z
  .object({
    key: LayerKey,
    /** Версия слоя, например `2026.10.1`. Пишется в `note` ревизии. */
    version: z.string().regex(SemVer, 'версия слоя: N.N.N'),
    schemaVersion: z.number().int().min(1),
    /** Ключи слоёв, поверх которых слой написан, в порядке сборки. */
    extends: z.array(LayerKey).optional(),
    requires: z.object({ product: z.string().regex(/^>=\d+\.\d+\.\d+$/, 'requires.product: >=N.N.N') }).strict().optional(),
  })
  .strict();
export type PresetMeta = z.infer<typeof PresetMeta>;

const JsonObj = z.custom<JsonObject>((v) => isPlainObject(v), 'ожидался объект');

export const PresetLayer = z
  .object({
    meta: PresetMeta,
    global: JsonObj.optional(),
    spaceDefaults: JsonObj.optional(),
    spaces: z.record(Key, JsonObj).optional(),
  })
  .strict();
export type PresetLayer = z.infer<typeof PresetLayer>;

export class PresetLayerError extends Error {
  override name = 'PresetLayerError';
}

/** Разобрать слой из JSON-файла: форма, чистый JSON, без `__proto__`. */
export function parseLayer(raw: unknown, source = 'слой'): PresetLayer {
  try {
    assertJson(raw);
  } catch (e) {
    throw new PresetLayerError(`${source}: ${(e as Error).message}`);
  }
  const r = PresetLayer.safeParse(raw);
  if (!r.success) throw new PresetLayerError(`${source}: ${r.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** `>=1.2.3` выполняется для версии продукта `version`. */
export function satisfiesProduct(range: string, version: string): boolean {
  const want = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const have = SemVer.exec(version.replace(/^v/, '').replace(/[-+].*$/, ''));
  if (!want || !have) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(have[i]) - Number(want[i]);
    if (d !== 0) return d > 0;
  }
  return true;
}

/**
 * Цепочка слоёв: ключи не повторяются; первый слой ни от кого не зависит; `extends` каждого слоя —
 * подпоследовательность ключей слоёв до него (накладка не может лечь раньше своей базы);
 * `requires.product` выполняется.
 */
export function checkLayerChain(layers: readonly PresetLayer[], productVersion: string): void {
  if (layers.length === 0) throw new PresetLayerError('нет слоёв');
  const seen: string[] = [];
  layers.forEach((l, i) => {
    const { key } = l.meta;
    if (seen.includes(key)) throw new PresetLayerError(`слой «${key}» указан дважды`);
    const ext = l.meta.extends ?? [];
    if (i === 0 && ext.length > 0) throw new PresetLayerError(`первый слой «${key}» не может расширять другие (extends: ${ext.join(', ')})`);
    let j = 0;
    for (const e of ext) {
      j = seen.indexOf(e, j);
      if (j < 0) throw new PresetLayerError(`слой «${key}» расширяет «${e}», но его нет раньше в цепочке (${seen.join(' → ') || 'пусто'})`);
      j++;
    }
    const req = l.meta.requires?.product;
    if (req && !satisfiesProduct(req, productVersion)) throw new PresetLayerError(`слой «${key}» требует продукт ${req}, а версия ${productVersion}`);
    seen.push(key);
  });
}

/** Собранный пресет до проверки схемой. */
export type AssembledPreset = {
  layers: { key: string; version: string }[];
  global: Json;
  spaces: Record<string, Json>;
};

/**
 * Собрать слои: проверка цепочки, миграция каждого слоя до текущей версии схемы, слияние.
 * Ключи пространств — из собранного `global.spaces[]` и из `spaces` слоёв (лишние поймает схема).
 */
export function assembleLayers(layers: readonly PresetLayer[], opts: { productVersion: string; schemaVersion?: number }): AssembledPreset {
  checkLayerChain(layers, opts.productVersion);
  const to = opts.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  const migrated = layers.map((l) => {
    const from = l.meta.schemaVersion;
    const m = (kind: 'global' | 'space', d: JsonObject | undefined) => (d === undefined ? undefined : migrateDoc(kind, d, from, to));
    return {
      meta: l.meta,
      global: m('global', l.global),
      spaceDefaults: m('space', l.spaceDefaults),
      spaces: Object.fromEntries(Object.entries(l.spaces ?? {}).map(([k, d]) => [k, m('space', d) as JsonObject])),
    };
  });

  let global: Json | undefined;
  for (const l of migrated) global = mergeJson(global, l.global);
  global ??= {};

  const keys = new Set<string>();
  const declared = isPlainObject(global) && Array.isArray(global.spaces) ? global.spaces : [];
  for (const s of declared) if (isPlainObject(s) && typeof s.key === 'string') keys.add(s.key);
  for (const l of migrated) for (const k of Object.keys(l.spaces)) keys.add(k);

  const spaces: Record<string, Json> = {};
  for (const k of keys) {
    let doc: Json | undefined;
    for (const l of migrated) {
      doc = mergeJson(doc, l.spaceDefaults);
      doc = mergeJson(doc, l.spaces[k]);
    }
    spaces[k] = doc ?? {};
  }
  return { layers: layers.map((l) => ({ key: l.meta.key, version: l.meta.version })), global, spaces };
}
