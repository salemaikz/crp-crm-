// Номера РК: одна реализация вместо трёх в SalemAI (приём лидов, `db/crm/phone.ts`,
// `splitPhones` импорта). Правила — PROCESS §2.3 п. 1 и CONFIG §6.3; граничные случаи — 12.33.
// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (splitPhones, phoneKind, isPlaceholderPhone),
// src/lib/db/crm/phone.ts (8 → 7), services/lead-collector/scraper.py (phone_digits).

import { classifyNational } from './rules.js';
import type { ParsedPhone, PhoneInvalidReason, PhoneRules } from './types.js';

/** Разделители номеров в ячейке: `,` `;` `/`, перевод строки, два и более пробела. */
const CELL_SPLIT = /[,;/\n\r]|\s{2,}/;

/** Добавочный в конце фрагмента: «доб. 12», «вн 5», «ext 7», «x12», «#12». */
const EXT_TAIL = /(?<![\p{L}\p{N}])(?:доб(?:авочный)?|вн|ext|x|#)\.?\s*:?\s*(\d{1,6})\s*$/iu;

/** Фрагмент из одного добавочного («доб. 12» после запятой) — относится к предыдущему номеру. */
const EXT_ONLY = /^(?:доб(?:авочный)?|вн|ext|x|#)\.?\s*:?\s*(\d{1,6})$/iu;

function isPlaceholder(digits11: string, rules: PhoneRules): boolean {
  const rest = digits11.slice(1);
  // Все цифры одинаковые (+7 777 777 77 77) или абонентская часть из одной цифры (+7 701 000 00 00).
  if (new Set(rest).size === 1 || new Set(rest.slice(3)).size === 1) return true;
  return rules.stubs?.includes(digits11) ?? false;
}

function invalid(raw: string, reason: PhoneInvalidReason, ext: string): ParsedPhone {
  return {
    raw,
    digits: null,
    e164: null,
    working: false,
    kind: 'unknown',
    needsReview: false,
    ext,
    invalidReason: reason,
  };
}

/**
 * Разобрать один номер. `null` — в строке нет цифр (текст «нет», пусто): это не номер.
 * 8 или 7 + 10 цифр → `7…`, 10 цифр → `7` + они; всё прочее нерабочее с причиной.
 * Короткие обрывки не угадываются (городской без кода остаётся `too_short`).
 */
export function parsePhone(input: string | null | undefined, rules: PhoneRules): ParsedPhone | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const extMatch = EXT_TAIL.exec(raw);
  const body = extMatch ? raw.slice(0, extMatch.index) : raw;
  const ext = extMatch?.[1] ?? '';
  let d = body.replace(/\D+/g, '');
  if (!d) return null;

  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  else if (d.length < 10) return invalid(raw, 'too_short', ext);
  else if (d.length === 11) return invalid(raw, 'foreign', ext);
  else return invalid(raw, 'too_long', ext);

  const national = d.slice(1);
  const base = { raw, digits: d, e164: `+${d}`, ext };
  if (isPlaceholder(d, rules)) {
    return { ...base, working: false, kind: 'unknown', needsReview: false, invalidReason: 'placeholder' };
  }
  if ('012'.includes(national[0]!)) {
    return { ...base, working: false, kind: 'unknown', needsReview: false, invalidReason: 'bad_code' };
  }
  const { kind, needsReview } = classifyNational(national, rules);
  return { ...base, working: true, kind, needsReview, invalidReason: null };
}

/** Канон `7XXXXXXXXXX` рабочего номера или `null` (заглушки и мусор отбрасываются). */
export function normalizePhone(input: string | null | undefined, rules: PhoneRules): string | null {
  const p = parsePhone(input, rules);
  return p?.working ? p.digits : null;
}

/**
 * Все номера из ячейки в порядке следования. Нерабочие остаются в списке (видны в отчёте
 * импорта, хранятся как нерабочие); повторы одного номера схлопываются. Фрагменты без цифр
 * пропускаются.
 */
export function splitPhones(cell: string | null | undefined, rules: PhoneRules): ParsedPhone[] {
  const out: ParsedPhone[] = [];
  const seen = new Set<string>();
  for (const chunk of (cell ?? '').split(CELL_SPLIT)) {
    const text = chunk.trim();
    if (!text) continue;
    const extOnly = EXT_ONLY.exec(text);
    if (extOnly) {
      const prev = out[out.length - 1];
      if (prev && !prev.ext) prev.ext = extOnly[1]!;
      continue;
    }
    const p = parsePhone(text, rules);
    if (!p) continue;
    const key = p.digits ?? `raw:${p.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
