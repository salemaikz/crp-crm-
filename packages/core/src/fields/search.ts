// search_norm — строка поиска клиента (D-015, D-123): свёрнутое название, БИН, номера и значения
// полей `searchable`, видимых всем ролям. Части разделены « | »: запрос состоит только из букв, цифр
// и пробелов, поэтому совпадение не склеивает соседние части. Поиск — `LIKE '%…%'` по trgm-индексу.
import { foldLetters, squashSeparators } from '../names/fold.js';
import { fieldsOf, visibleToAllRoles } from './access.js';
import type { CustomValues, FieldDef, FieldRole, FieldType } from './types.js';

export const SEARCH_NORM_MAX = 4000;
export const SEARCH_SEPARATOR = ' | ';
/** PROCESS 8.3: от 3 символов названия, от 5 цифр номера. */
export const SEARCH_MIN_TEXT = 3;
export const SEARCH_MIN_DIGITS = 5;
export const SEARCH_QUERY_MAX = 100;

/** Типы, значения которых идут в поиск. Списки ищутся фильтром, а не текстом. */
const SEARCH_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['text', 'textarea', 'email', 'url', 'phone']);

/** Свёртка текста для поиска: регистр, ё и казахские буквы, всё не-буквенно-цифровое — пробел. */
export function foldForSearch(s: string): string {
  return squashSeparators(foldLetters(s));
}

/**
 * Поля объекта `client`, которые попадают в search_norm: `searchable`, не архивные, текстового типа
 * и видимые **каждой** неархивной роли — иначе поиск выдавал бы скрытое значение по совпадению.
 */
export function searchableKeys(fields: readonly FieldDef[], roles: readonly FieldRole[]): string[] {
  return fieldsOf(fields, 'client')
    .filter((f) => f.searchable && !f.archived && SEARCH_TYPES.has(f.type) && visibleToAllRoles(f, roles))
    .map((f) => f.key);
}

export interface SearchNormInput {
  name: string;
  /** БИН ('' если нет). ИИН в поиск не входит никогда: хранится только HMAC. */
  orgId: string;
  /** Номера клиента в каноне `7XXXXXXXXXX` (все, включая нерабочие). */
  phones: readonly string[];
  custom: CustomValues;
  /** Результат searchableKeys. */
  searchable: readonly string[];
}

/** Строка для `clients.search_norm`. Пересчитывается при каждой правке названия, номеров и полей. */
export function buildSearchNorm(input: SearchNormInput): string {
  const parts: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t && !parts.includes(t)) parts.push(t);
  };
  push(foldForSearch(input.name));
  push(input.orgId.replace(/\D+/g, ''));
  for (const p of input.phones) push(p.replace(/\D+/g, ''));
  for (const key of input.searchable) {
    const v = Object.hasOwn(input.custom, key) ? input.custom[key] : undefined;
    if (typeof v === 'string') push(foldForSearch(v));
  }
  const out = parts.join(SEARCH_SEPARATOR);
  return out.length > SEARCH_NORM_MAX ? out.slice(0, SEARCH_NORM_MAX) : out;
}

export type SearchQuery =
  /** Пустой запрос — список без поиска. */
  | { kind: 'none' }
  /** Короче порога: интерфейс просит ввести больше, сервер не ищет. */
  | { kind: 'short' }
  /** Шаблоны LIKE (1–2 штуки): `%значение%`. Сравнивать с `search_norm` через OR. */
  | { kind: 'text' | 'digits'; patterns: string[] };

/**
 * Разобрать строку поиска. Номер — если кроме цифр только `+ ( ) - .` и пробелы: цифры, ведущая 8
 * даёт второй вариант с 7. Иначе текст в той же свёртке, что search_norm.
 */
export function parseSearchQuery(q: string | null | undefined): SearchQuery {
  const s = (q ?? '').slice(0, SEARCH_QUERY_MAX).trim();
  if (!s) return { kind: 'none' };
  if (/^[\d\s+()\-.]+$/.test(s)) {
    const d = s.replace(/\D+/g, '');
    if (d.length < SEARCH_MIN_DIGITS) return { kind: 'short' };
    const patterns = [`%${d}%`];
    if (d.startsWith('8') && d.length > SEARCH_MIN_DIGITS) patterns.push(`%7${d.slice(1)}%`);
    return { kind: 'digits', patterns };
  }
  const t = foldForSearch(s);
  if (t.replace(/\s+/g, '').length < SEARCH_MIN_TEXT) return { kind: 'short' };
  return { kind: 'text', patterns: [`%${t}%`] };
}
