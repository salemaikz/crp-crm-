// Слияние слоёв пресета и наложение правок (CONFIG §3.1, D-061, D-082).
// - объекты сливаются по полям, глубоко;
// - массивы объектов с `key` — по `key`, с `date` (праздники) — по `date`: элемент перекрывается
//   частично, новый добавляется в конец, порядок базы сохраняется;
// - остальные массивы (`workdays`, `grants`, `rejectRules`) заменяются целиком;
// - `null` — значение («выключено»), а не удаление; отсутствие ключа — «не менять»;
// - удаления нет: пустой массив с ключом ничего не убирает, убирают `archived: true`.
import { cloneJson, FORBIDDEN_KEYS, isPlainObject, type Json, type JsonObject } from './json.js';
import { arrayMergeKey, ConfigPathError, formatPath, indexByKey, type Path } from './paths.js';

export class ConfigMergeError extends Error {
  override name = 'ConfigMergeError';
}

/** Наложить `overlay` на `base`. Входы не мутируются. */
export function mergeJson(base: Json | undefined, overlay: Json | undefined, path: Path = []): Json | undefined {
  if (overlay === undefined) return base === undefined ? undefined : cloneJson(base);
  if (base === undefined) return checked(overlay, path);
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: JsonObject = cloneJson(base);
    for (const k of Object.keys(overlay)) {
      if (FORBIDDEN_KEYS.has(k)) throw new ConfigMergeError(`${formatPath([...path, k])}: запрещённый ключ`);
      const merged = mergeJson(Object.hasOwn(out, k) ? out[k] : undefined, overlay[k], [...path, k]);
      if (merged !== undefined) out[k] = merged;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(overlay)) return mergeArrays(base, overlay, path);
  // Разные типы или примитивы: побеждает слой выше.
  return checked(overlay, path);
}

function mergeArrays(base: Json[], overlay: Json[], path: Path): Json[] {
  let by;
  try {
    by = arrayMergeKey(base, overlay);
  } catch (e) {
    throw new ConfigMergeError(`${formatPath(path)}: ${(e as Error).message}`);
  }
  if (by === null) return overlay.map((el, i) => checked(el, [...path, String(i)]));
  const baseIdx = wrap(() => indexByKey(base, by, path));
  const overIdx = wrap(() => indexByKey(overlay, by, path));
  const out: Json[] = base.map((el) => {
    const id = (el as JsonObject)[by] as string;
    const over = overIdx.get(id);
    return over ? (mergeJson(el, over, [...path, { by, id }]) as Json) : cloneJson(el);
  });
  for (const el of overlay) {
    const id = (el as JsonObject)[by] as string;
    if (!baseIdx.has(id)) out.push(checked(el, [...path, { by, id }]));
  }
  return out;
}

function wrap<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ConfigPathError) throw new ConfigMergeError(e.message);
    throw e;
  }
}

/** Копия значения слоя с проверкой вложенных массивов и ключей (повторы key/date, смесь, __proto__). */
function checked(v: Json, path: Path): Json {
  if (Array.isArray(v)) return mergeArrays([], v, path);
  if (isPlainObject(v)) return mergeJson({}, v, path) as Json;
  return v;
}

/** Слить слои по порядку: каждый следующий частично перекрывает предыдущие. */
export function mergeLayers(layers: readonly (Json | undefined)[]): Json | undefined {
  return layers.reduce<Json | undefined>((acc, l) => mergeJson(acc, l), undefined);
}
