// Дифф двух документов настроек для `crmctl config diff/apply` и журнала ревизий.
// Элементы массивов с ключом сравниваются по ключу (перестановка — не изменение), массивы без ключа —
// как одно значение.
import { deepEqual, isPlainObject, type Json, type JsonObject } from './json.js';
import { arrayMergeKey, formatPath, indexByKey, type Path } from './paths.js';

export type ConfigChange = {
  path: Path;
  op: 'add' | 'remove' | 'change';
  before?: Json;
  after?: Json;
};

export function diffJson(before: Json | undefined, after: Json | undefined, path: Path = []): ConfigChange[] {
  if (deepEqual(before, after)) return [];
  if (before === undefined) return [{ path, op: 'add', after }];
  if (after === undefined) return [{ path, op: 'remove', before }];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) =>
      diffJson(Object.hasOwn(before, k) ? before[k] : undefined, Object.hasOwn(after, k) ? after[k] : undefined, [...path, k]),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const by = arrayMergeKey(before, after);
    if (by !== null) {
      const a = indexByKey(before, by, path);
      const b = indexByKey(after, by, path);
      const ids = [...new Set([...a.keys(), ...b.keys()])];
      return ids.flatMap((id) => diffJson(a.get(id) as JsonObject | undefined, b.get(id) as JsonObject | undefined, [...path, { by, id }]));
    }
  }
  return [{ path, op: 'change', before, after }];
}

/** Строки диффа для печати в CLI: `~ path: before → after`. Значения — компактный JSON. */
export function formatDiff(changes: readonly ConfigChange[]): string[] {
  const j = (v: Json | undefined) => JSON.stringify(v);
  return changes.map((c) => {
    const p = formatPath(c.path);
    if (c.op === 'add') return `+ ${p}: ${j(c.after)}`;
    if (c.op === 'remove') return `- ${p}: ${j(c.before)}`;
    return `~ ${p}: ${j(c.before)} → ${j(c.after)}`;
  });
}
