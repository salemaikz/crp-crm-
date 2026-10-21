// Локальное состояние доски (B8): перенос плитки между колонками до ответа сервера. Чистые функции без React.
import type { BoardColumn, DealTile } from '@/server/domain/deals/boardTypes';

const byAge = (a: DealTile, b: DealTile): number => a.stageChangedAt - b.stageChangedAt || a.id.localeCompare(b.id);

/**
 * Поставить плитку в колонку `stageKey`: из старой колонки она убирается (счётчик −1), в новую встаёт по порядку
 * «давнее выше» (счётчик +1). Нет такой колонки (закрытый этап) — плитка просто пропадает с доски.
 */
export function placeTile(columns: readonly BoardColumn[], tile: DealTile, stageKey: string): BoardColumn[] {
  return columns.map((c) => {
    const has = c.deals.some((d) => d.id === tile.id);
    if (c.stageKey === stageKey) {
      const rest = c.deals.filter((d) => d.id !== tile.id);
      return { ...c, total: has ? c.total : c.total + 1, deals: [...rest, { ...tile, stageKey }].sort(byAge) };
    }
    return has ? { ...c, total: Math.max(0, c.total - 1), deals: c.deals.filter((d) => d.id !== tile.id) } : c;
  });
}

/** Добавить загруженную страницу «ещё» к колонке (без повторов). */
export function appendPage(columns: readonly BoardColumn[], page: BoardColumn): BoardColumn[] {
  return columns.map((c) => {
    if (c.stageKey !== page.stageKey) return c;
    const have = new Set(c.deals.map((d) => d.id));
    return { ...c, total: page.total, deals: [...c.deals, ...page.deals.filter((d) => !have.has(d.id))], nextCursor: page.nextCursor };
  });
}
