// Ячейки «Ответ», «ЛПР», «Статус» (PROCESS 3.7). Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts
// (parseAnswerCell, parseLpr, parseTargetStatus). Отличия: карты значений и приоритет приходят из
// профиля (CONFIG 6.13), а не из кода; приоритет — по PROCESS 3.7 (Перезвонить выше «Не берёт»;
// в SalemAI было наоборот); неизвестное значение не угадывается.

import type { ImportProfile, LprValue, ParsedAnswer, TargetValue } from './types';

/** Подпись для сопоставления: без регистра, ё = е, пробелы схлопнуты. */
export function normalizeLabel(s: string): string {
  return (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

const normKeys = <T>(m: Readonly<Record<string, T>>): Map<string, T> =>
  new Map(Object.entries(m).map(([k, v]) => [normalizeLabel(k), v]));

/** Карты профиля с нормализованными ключами — готовятся один раз на файл. */
export interface CompiledMaps {
  outcome: Map<string, string>;
  lpr: Map<string, LprValue>;
  target: Map<string, TargetValue>;
  /** Место ключа итога в приоритете (меньше — главнее). */
  rank: Map<string, number>;
}

export function compileMaps(profile: ImportProfile): CompiledMaps {
  return {
    outcome: normKeys(profile.valueMaps.outcome),
    lpr: normKeys(profile.valueMaps.lpr),
    target: normKeys(profile.valueMaps.target),
    rank: new Map(profile.outcomePriority.map((k, i) => [k, i])),
  };
}

/**
 * Ячейка итога. Значения делятся по `,` и `;` (в «Отключен/Не берет» косая черта — часть значения).
 * Итог один на звонок: главный выбирается по `outcomePriority`; ключи вне списка уступают
 * перечисленным и сравниваются по порядку в ячейке. Исходный текст сохраняется.
 */
export function parseAnswerCell(cell: string, maps: CompiledMaps): ParsedAnswer {
  const values: ParsedAnswer['values'] = [];
  const unknown: string[] = [];
  for (const part of (cell ?? '').split(/[,;]/)) {
    const raw = part.trim();
    if (!raw) continue;
    const key = maps.outcome.get(normalizeLabel(raw));
    if (key === undefined) unknown.push(raw);
    else if (!values.some((v) => v.outcomeKey === key)) values.push({ raw, outcomeKey: key });
  }
  let primary: string | null = null;
  let best = Infinity;
  for (const v of values) {
    const r = maps.rank.get(v.outcomeKey) ?? Number.MAX_SAFE_INTEGER;
    if (r < best || primary === null) {
      best = r;
      primary = v.outcomeKey;
    }
  }
  return { raw: (cell ?? '').trim(), values, primary, unknown };
}

/** `''` — пусто (пусто ≠ «Нет»), `null` — не распознано. */
export function parseLpr(cell: string, maps: Pick<CompiledMaps, 'lpr'>): LprValue | '' | null {
  const v = normalizeLabel(cell);
  if (!v) return '';
  return maps.lpr.get(v) ?? null;
}

/** `''` — пусто («Целевой» остаётся «не выяснено», статус догадкой не выводится), `null` — не распознано. */
export function parseTarget(cell: string, maps: Pick<CompiledMaps, 'target'>): TargetValue | '' | null {
  const v = normalizeLabel(cell);
  if (!v) return '';
  return maps.target.get(v) ?? null;
}

/** Виды итога, с которыми «Целевой» несовместим. */
const NOT_TARGET_KINDS = new Set(['not_target', 'do_not_call', 'bad_number']);

/** Противоречие строки (PROCESS 3.7: 57 строк): импорт ставит «проверить», загрузку не блокирует. */
export function isContradiction(target: TargetValue | '' | null, outcomeKind: string | null): boolean {
  if (!outcomeKind) return false;
  return (target === 'target' && NOT_TARGET_KINDS.has(outcomeKind)) || (target === 'non_target' && outcomeKind === 'agreed');
}
