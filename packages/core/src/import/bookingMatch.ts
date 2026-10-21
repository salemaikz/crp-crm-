// Сопоставление строк таблицы записей (D-324, docs/import-bookings-design.md §5.1, §5.4): клиент по БИН/ИИН-HMAC,
// номеру и названию; подсказка автора по номеру или ФИО. Чистые функции без БД.

import { normalizeLabel } from './answer';
import { PERSONAL_ID_PREFIX } from './personalId';
import type { ImportNormalizers } from './types';

/** Клиент-кандидат: только тот, у кого есть карточка в пространстве РОП (охват задаёт вызывающий). */
export interface BookingClientKeys {
  nameNorm: string;
  /** Открытый БИН клиента или ''. */
  orgId: string;
  /** Скрытый ключ ИИН `iin:<HMAC>` или null. */
  iinKey: string | null;
  /** Рабочие номера клиента (канон). */
  phones: readonly string[];
}

export type BookingMatchBy = 'org' | 'phone' | 'phone_name';

export type BookingMatch<T> = { kind: 'found'; by: BookingMatchBy; candidate: T } | { kind: 'ambiguous' } | { kind: 'not_found' };

export interface BookingRowKeys {
  orgId: string | null;
  orgIdUncertain: boolean;
  workingPhones: readonly string[];
  nameNorm: string;
}

/**
 * Клиент строки:
 *  1. есть `orgId` — клиент с тем же БИН (или `iin:<HMAC>`); неуверенно скрытый номер сверяется и с открытым
 *     БИН клиента через `hidden` (D-141);
 *  2. иначе (или по `orgId` никого) — единственный клиент с общим рабочим номером, у которого нет другого
 *     БИН/ИИН; несколько — тот, у кого совпало нормализованное название, иначе «неоднозначно»:
 *     общий номер бухгалтера у разных ТОО не склеиваем.
 */
export function matchBookingClient<T extends BookingClientKeys>(row: BookingRowKeys, candidates: readonly T[], hidden?: (bin: string) => string): BookingMatch<T> {
  const key = row.orgId;
  if (key) {
    const byOrg = candidates.filter(
      (c) =>
        (c.orgId !== '' && c.orgId === key) ||
        (c.iinKey !== null && c.iinKey === key) ||
        (row.orgIdUncertain && key.startsWith(PERSONAL_ID_PREFIX) && c.orgId !== '' && hidden?.(c.orgId) === key),
    );
    if (byOrg.length === 1) return { kind: 'found', by: 'org', candidate: byOrg[0] as T };
    if (byOrg.length > 1) return { kind: 'ambiguous' };
  }
  const phones = new Set(row.workingPhones);
  if (phones.size === 0) return { kind: 'not_found' };
  const shared = candidates.filter((c) => c.phones.some((p) => phones.has(p)) && (!row.orgId || (c.orgId === '' && c.iinKey === null)));
  if (shared.length === 0) return { kind: 'not_found' };
  if (shared.length === 1) return { kind: 'found', by: 'phone', candidate: shared[0] as T };
  const named = shared.filter((c) => c.nameNorm !== '' && c.nameNorm === row.nameNorm);
  return named.length === 1 ? { kind: 'found', by: 'phone_name', candidate: named[0] as T } : { kind: 'ambiguous' };
}

/** Сотрудник пространства для подсказки автора. */
export interface AuthorStaff {
  userId: string;
  name: string;
  phoneDigits: string;
}

export type AuthorSuggestion = { by: 'phone' | 'name'; userId: string } | { by: 'ambiguous' | 'none'; userId: null };

const wordsOf = (s: string): string => [...new Set(s.split(/\s+/).filter(Boolean))].sort().join(' ');

/**
 * Подсказка автора для ярлыка из таблицы: в ярлыке 10–15 цифр — номер сотрудника (по последним 10 цифрам),
 * иначе то же множество слов ФИО в любом порядке. Подсказка только предзаполняет выбор: карту утверждает РОП.
 */
export function suggestAuthor(label: string, staff: readonly AuthorStaff[], n: Pick<ImportNormalizers, 'normalizePerson'>): AuthorSuggestion {
  const digits = (label ?? '').replace(/\D+/g, '');
  if (digits.length >= 10 && digits.length <= 15) {
    const tail = digits.slice(-10);
    const hit = staff.filter((s) => s.phoneDigits.slice(-10) === tail);
    if (hit.length === 1) return { by: 'phone', userId: (hit[0] as AuthorStaff).userId };
    if (hit.length > 1) return { by: 'ambiguous', userId: null };
  }
  const words = wordsOf(n.normalizePerson(label));
  if (words === '') return { by: 'none', userId: null };
  const hit = staff.filter((s) => wordsOf(n.normalizePerson(s.name)) === words);
  if (hit.length === 1) return { by: 'name', userId: (hit[0] as AuthorStaff).userId };
  return hit.length > 1 ? { by: 'ambiguous', userId: null } : { by: 'none', userId: null };
}

/** Карта решений РОП: нормализованный ярлык → сотрудник, null — «автор неизвестен», нет ключа — не решено. */
export type AuthorMap = Readonly<Record<string, string | null | undefined>>;

/** Решение по ярлыку автора с учётом нормализации (регистр, ё, пробелы). */
export function authorDecision(map: AuthorMap, label: string | null): { decided: boolean; userId: string | null } {
  if (label === null || label.trim() === '') return { decided: true, userId: null };
  const key = normalizeLabel(label);
  for (const [k, v] of Object.entries(map)) {
    if (normalizeLabel(k) === key && v !== undefined) return { decided: true, userId: v };
  }
  return { decided: false, userId: null };
}
