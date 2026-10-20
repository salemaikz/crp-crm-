// Нормализация названий компаний для дедупа (PROCESS §2.3 п. 1): без формы собственности,
// кавычек и знаков, регистр и казахские буквы свёрнуты. Ключ сравнения, а не показываемое имя.
// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (normalizeCompanyName, normalizePersonName),
// src/lib/db/crm/coldMatch.ts (правила сопоставления используют эти ключи).

import { foldLetters, squashSeparators } from './fold.js';
import { DEFAULT_LEGAL_FORMS, type LegalForm } from './legalForm.js';

/** «Товарищество … "Концерн "Найза""» и «ТОО Концерн Найза» → «концерн найза». */
export function normalizeCompanyName(
  name: string | null | undefined,
  forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS,
): string {
  let s = squashSeparators(foldLetters(name ?? ''));
  if (!s) return '';
  // Полные формы — подстрокой по свёрнутому тексту (разделители уже пробелы).
  for (const f of forms) {
    for (const full of f.full) {
      const key = squashSeparators(foldLetters(full));
      if (key) s = ` ${s} `.split(` ${key} `).join(' ').trim();
    }
  }
  const short = new Set(forms.flatMap((f) => f.short.map((x) => foldLetters(x))));
  return s
    .split(' ')
    .filter((w) => w && !short.has(w))
    .join(' ');
}

/** Ключ формы собственности, найденной в названии (первая по списку), или `null`. */
export function detectLegalForm(
  name: string | null | undefined,
  forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS,
): string | null {
  const s = ` ${squashSeparators(foldLetters(name ?? ''))} `;
  for (const f of forms) {
    if (f.full.some((x) => s.includes(` ${squashSeparators(foldLetters(x))} `))) return f.key;
    if (f.short.some((x) => s.includes(` ${foldLetters(x)} `))) return f.key;
  }
  return null;
}

/** ФИО для сравнения руководителей: регистр, ё, казахские буквы, только буквы. */
export function normalizePersonName(name: string | null | undefined): string {
  return squashSeparators(foldLetters(name ?? '').replace(/[^\p{L}\s]/gu, ' '));
}

/** БИН: ровно 12 цифр после удаления нецифр, иначе пустая строка. */
export function normalizeBin(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D+/g, '');
  return d.length === 12 ? d : '';
}
