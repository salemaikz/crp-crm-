// Нормализация названий компаний для дедупа (PROCESS §2.3 п. 1): без формы собственности,
// кавычек и знаков, регистр и казахские буквы свёрнуты. Ключ сравнения, а не показываемое имя.
// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (normalizeCompanyName, normalizePersonName),
// src/lib/db/crm/coldMatch.ts (правила сопоставления используют эти ключи).

import { foldLetters, squashSeparators } from './fold.js';
import { DEFAULT_LEGAL_FORMS, type LegalForm } from './legalForm.js';

/** «Товарищество … "Пример "Гамма""» и «ТОО Пример Гамма» → «пример гамма». */
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

/**
 * Ключ формы собственности, найденной в названии (первая по списку), или `null`.
 * Аббревиатуры `typeOnly` (`жк`) в названии формой не считаются — только полная форма.
 */
export function detectLegalForm(
  name: string | null | undefined,
  forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS,
): string | null {
  return findForm(name, forms, false);
}

/**
 * Ключ формы по значению колонки «Тип» (`ИП`, `ИП.`, `Индивидуальный предприниматель`, `ЖК`,
 * `Жеке кәсіпкер`) или `null`, если значение не распознано. Здесь `typeOnly` тоже признаются.
 */
export function legalFormOfTypeCell(
  cell: string | null | undefined,
  forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS,
): string | null {
  return findForm(cell, forms, true);
}

function findForm(text: string | null | undefined, forms: readonly LegalForm[], typeCell: boolean): string | null {
  const s = ` ${squashSeparators(foldLetters(text ?? ''))} `;
  if (!s.trim()) return null;
  const has = (x: string) => {
    const k = squashSeparators(foldLetters(x));
    return k !== '' && s.includes(` ${k} `);
  };
  for (const f of forms) {
    if (f.full.some(has) || f.short.some(has) || (typeCell && (f.typeOnly ?? []).some(has))) return f.key;
  }
  return null;
}

/** Код формы для правил и профиля — первая аббревиатура (`тоо`, `ип`), затем первая из `typeOnly`, иначе ключ. */
export function legalFormCode(key: string | null, forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS): string {
  if (!key) return '';
  const f = forms.find((x) => x.key === key);
  return f ? foldLetters(f.short[0] ?? f.typeOnly?.[0] ?? f.key) : '';
}

/** Коды форм с «личным» номером (`idIsPersonal`): `ип`, `кх` (D-052, D-141). */
export function personalFormCodes(forms: readonly LegalForm[] = DEFAULT_LEGAL_FORMS): string[] {
  return forms.filter((f) => f.idIsPersonal).map((f) => legalFormCode(f.key, forms)).filter(Boolean);
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
