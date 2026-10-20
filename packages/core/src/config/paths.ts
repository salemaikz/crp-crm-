// Пути внутри документа настроек: для диффа, отчёта обновления пресета и `crmctl config set`.
// Элемент массива с ключом адресуется ключом, а не позицией: `calling.outcomes[key=agreed].label.ru`,
// `calendar.holidays[date=2026-03-08].note`. Массивы без ключа — атомарные значения (D-082).
import { FORBIDDEN_KEYS, isPlainObject, type Json, type JsonObject } from './json.js';

export type MergeKey = 'key' | 'date';
export type PathSeg = string | { by: MergeKey; id: string };
export type Path = readonly PathSeg[];

export class ConfigPathError extends Error {
  override name = 'ConfigPathError';
}

/**
 * Как сливать массив: по `key`, по `date` или целиком. Решает содержимое обоих массивов: все элементы —
 * объекты со строковым `key` → по `key`; все без `key`, но со строковым `date` → по `date`; иначе
 * (числа, строки, объекты без ключа, пустые массивы) — замена целиком. Смесь элементов с ключом и без —
 * ошибка: такой массив нельзя слить предсказуемо.
 */
export function arrayMergeKey(...arrays: readonly (readonly Json[])[]): MergeKey | null {
  const all = arrays.flat();
  if (all.length === 0) return null;
  const has = (k: MergeKey) => (x: Json) => isPlainObject(x) && typeof x[k] === 'string';
  if (all.every(has('key'))) return 'key';
  if (all.every((x) => isPlainObject(x) && !Object.hasOwn(x, 'key')) && all.every(has('date'))) return 'date';
  if (all.some((x) => isPlainObject(x) && (Object.hasOwn(x, 'key') || Object.hasOwn(x, 'date')))) {
    throw new ConfigPathError('массив смешивает элементы с ключом (key/date) и без него');
  }
  return null;
}

/** Ид элемента массива по ключу слияния. Повтор ида — ошибка. */
export function indexByKey(arr: readonly Json[], by: MergeKey, where: Path = []): Map<string, JsonObject> {
  const m = new Map<string, JsonObject>();
  for (const el of arr) {
    const obj = el as JsonObject;
    const id = obj[by] as string;
    if (m.has(id)) throw new ConfigPathError(`${formatPath(where)}: повтор ${by}=${id}`);
    m.set(id, obj);
  }
  return m;
}

const PLAIN_SEG = /^[A-Za-z0-9_*-]+$/;

export function formatPath(path: Path): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'string') out += PLAIN_SEG.test(seg) ? (out ? `.${seg}` : seg) : `[${JSON.stringify(seg)}]`;
    else out += `[${seg.by}=${seg.id}]`;
  }
  return out || '$';
}

/** Разбор пути из `formatPath`. `$` или пустая строка — корень. */
export function parsePath(s: string): PathSeg[] {
  const out: PathSeg[] = [];
  if (s === '$' || s === '') return out;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') {
      if (out.length === 0) throw new ConfigPathError(`путь «${s}»: точка в начале`);
      i++;
    }
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new ConfigPathError(`путь «${s}»: нет «]»`);
      const inner = s.slice(i + 1, end);
      if (inner.startsWith('"')) {
        // Ключ в кавычках может содержать «]»: ищем закрывающую кавычку перед «]».
        const close = findQuotedEnd(s, i + 1);
        out.push(JSON.parse(s.slice(i + 1, close + 1)) as string);
        if (s[close + 1] !== ']') throw new ConfigPathError(`путь «${s}»: ожидалась «]»`);
        i = close + 2;
        continue;
      }
      const m = /^(key|date)=(.+)$/.exec(inner);
      if (!m) throw new ConfigPathError(`путь «${s}»: сегмент «[${inner}]» — нужен [key=…], [date=…] или ["…"]`);
      out.push({ by: m[1] as MergeKey, id: m[2] as string });
      i = end + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_*-]+/.exec(s.slice(i));
    if (!m) throw new ConfigPathError(`путь «${s}»: неверный символ в позиции ${i}`);
    out.push(m[0]);
    i += m[0].length;
  }
  for (const seg of out) if (typeof seg === 'string' && FORBIDDEN_KEYS.has(seg)) throw new ConfigPathError(`путь «${s}»: запрещённый ключ`);
  return out;
}

function findQuotedEnd(s: string, start: number): number {
  for (let j = start + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j;
  }
  throw new ConfigPathError(`путь «${s}»: нет закрывающей кавычки`);
}

/** Значение по пути или undefined. */
export function getAt(doc: Json | undefined, path: Path): Json | undefined {
  let cur: Json | undefined = doc;
  for (const seg of path) {
    if (cur === undefined) return undefined;
    if (typeof seg === 'string') {
      cur = isPlainObject(cur) && Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    } else {
      cur = Array.isArray(cur) ? cur.find((x) => isPlainObject(x) && x[seg.by] === seg.id) : undefined;
    }
  }
  return cur;
}

/**
 * Новый документ, где по пути стоит `value`. Недостающие объекты создаются; недостающий элемент массива
 * с ключом создаётся как `{ <by>: id }` в конце массива. Полноту результата проверяет схема.
 */
export function setAt(doc: Json, path: Path, value: Json): Json {
  if (path.length === 0) return value;
  const [seg, ...rest] = path as [PathSeg, ...PathSeg[]];
  if (typeof seg === 'string') {
    if (FORBIDDEN_KEYS.has(seg)) throw new ConfigPathError(`запрещённый ключ «${seg}»`);
    const obj: JsonObject = isPlainObject(doc) ? { ...doc } : {};
    obj[seg] = setAt(Object.hasOwn(obj, seg) ? (obj[seg] as Json) : {}, rest, value);
    return obj;
  }
  if (!Array.isArray(doc)) throw new ConfigPathError(`сегмент [${seg.by}=${seg.id}] применён не к массиву`);
  const idx = doc.findIndex((x) => isPlainObject(x) && x[seg.by] === seg.id);
  const arr = [...doc];
  if (idx >= 0) arr[idx] = setAt(arr[idx] as Json, rest, value);
  else arr.push(setAt({ [seg.by]: seg.id }, rest, value));
  return arr;
}
