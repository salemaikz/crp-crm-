// Обновление пресета поверх живых настроек — трёхстороннее слияние (D-061, D-082).
// Три документа одной области: `current` — живая ревизия; `prevPreset` — `preset_doc` последней ревизии
// `source=preset` (что пресет ставил в прошлый раз); `nextPreset` — новый собранный пресет.
// Значение из нового пресета применяется, только если клиент его не трогал (current == prevPreset).
// Иначе — «оставлено как у клиента» (в отчёт), с `force` — перезапись. Ничего не удаляется.
import { cloneJson, deepEqual, isPlainObject, type Json, type JsonObject } from './json.js';
import { arrayMergeKey, indexByKey, type Path } from './paths.js';

export type PresetUpdateItem = { path: Path; before?: Json; after?: Json; preset?: Json };

export type PresetUpdateResult = {
  doc: Json;
  /** Применено из нового пресета (в т. ч. новые ключи). */
  applied: PresetUpdateItem[];
  /** Клиент менял значение — оставлено как у клиента; `preset` — что предлагал пресет. */
  kept: PresetUpdateItem[];
  /** Перезаписано поверх правок клиента флагом `force`. */
  forced: PresetUpdateItem[];
};

export function presetUpdate(input: { current: Json | undefined; prevPreset: Json | undefined; nextPreset: Json; force?: boolean }): PresetUpdateResult {
  const res: PresetUpdateResult = { doc: null, applied: [], kept: [], forced: [] };
  const doc = merge3(input.current, input.prevPreset, input.nextPreset, [], input.force ?? false, res);
  res.doc = doc === undefined ? cloneJson(input.nextPreset) : doc;
  return res;
}

function merge3(cur: Json | undefined, prev: Json | undefined, next: Json | undefined, path: Path, force: boolean, res: PresetUpdateResult): Json | undefined {
  if (next === undefined) return cur; // пресет убрал ключ — у клиента остаётся
  if (deepEqual(cur, next)) return cur;
  if (cur === undefined) {
    // Новый ключ пресета — добавляем. Если ключ был в прошлом пресете, а у клиента его нет, клиент его убрал
    // (необязательное поле, например `kk` подписи): это правка клиента.
    if (prev === undefined || !deepEqual(prev, next)) {
      if (prev === undefined) return push(res.applied, path, cur, next, cloneJson(next));
      return leafConflict(cur, next, path, force, res);
    }
    return cur;
  }
  const prevObj = isPlainObject(prev) ? prev : undefined;
  if (isPlainObject(cur) && isPlainObject(next)) {
    const out: JsonObject = { ...cur };
    for (const k of Object.keys(next)) {
      const v = merge3(Object.hasOwn(cur, k) ? cur[k] : undefined, prevObj && Object.hasOwn(prevObj, k) ? prevObj[k] : undefined, next[k], [...path, k], force, res);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(cur) && Array.isArray(next)) {
    const prevArr = Array.isArray(prev) ? prev : [];
    const by = arrayMergeKey(cur, next, prevArr);
    if (by !== null) {
      const p = indexByKey(prevArr, by, path);
      const n = indexByKey(next, by, path);
      const c = indexByKey(cur, by, path);
      const out: Json[] = cur.map((el) => {
        const id = (el as JsonObject)[by] as string;
        return n.has(id) ? (merge3(el, p.get(id), n.get(id), [...path, { by, id }], force, res) as Json) : el;
      });
      for (const el of next) {
        const id = (el as JsonObject)[by] as string;
        if (c.has(id)) continue;
        const v = merge3(undefined, p.get(id), el, [...path, { by, id }], force, res);
        if (v !== undefined) out.push(v);
      }
      return out;
    }
  }
  // Лист: примитив, массив без ключа или смена типа.
  if (deepEqual(cur, prev)) return push(res.applied, path, cur, next, cloneJson(next));
  return leafConflict(cur, next, path, force, res);
}

function leafConflict(cur: Json | undefined, next: Json, path: Path, force: boolean, res: PresetUpdateResult): Json | undefined {
  if (force) return push(res.forced, path, cur, next, cloneJson(next));
  res.kept.push({ path, ...(cur === undefined ? {} : { before: cur }), preset: next });
  return cur;
}

function push(list: PresetUpdateItem[], path: Path, before: Json | undefined, after: Json, ret: Json): Json {
  list.push({ path, ...(before === undefined ? {} : { before }), after });
  return ret;
}
