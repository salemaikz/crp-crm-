// Перенос «в уме» (pipeline-v2 §3.4): после подтверждения плитка сразу переезжает в колонку-цель, не дожидаясь
// сервера. Пока итог в очереди устройства или в окне «Отменить», эта раскладка накладывается на то, что вернул сервер.
// Чистые функции: проверяются юнит-тестами.
import type { BoardCardDto } from './types';

export interface Placement {
  cardId: string;
  /** Колонка-цель. */
  column: string;
  /** Что поменяется в плитке по итогу (состояние, причина, срок). */
  patch: Partial<BoardCardDto>;
  /** Операция в очереди устройства или отложенная; по ней перенос снимается после отправки или отмены. */
  opId: string;
}

export type ColumnCards = Record<string, BoardCardDto[]>;

/** Колонки с наложенными переносами: плитка убрана из прежней колонки и стоит первой в целевой. */
export function applyPlacements(cols: ColumnCards, placements: readonly Placement[]): ColumnCards {
  if (placements.length === 0) return cols;
  const moved = new Map<string, Placement>(placements.map((p) => [p.cardId, p]));
  const found = new Map<string, BoardCardDto>();
  for (const cards of Object.values(cols)) for (const c of cards) if (moved.has(c.id)) found.set(c.id, c);
  const out: ColumnCards = {};
  for (const [key, cards] of Object.entries(cols)) {
    const rest = cards.filter((c) => !moved.has(c.id));
    const incoming = placements
      .filter((p) => p.column === key && found.has(p.cardId))
      .map((p) => ({ ...found.get(p.cardId)!, ...p.patch, column: key }) as BoardCardDto);
    out[key] = [...incoming, ...rest];
  }
  return out;
}

/** Сколько карточек в колонке на экране (число в шапке и вкладке): загруженные плюс «Ещё» не считаем — это нижняя граница. */
export const countOf = (cards: readonly BoardCardDto[], hasMore: boolean): { n: number; more: boolean } => ({ n: cards.length, more: hasMore });
