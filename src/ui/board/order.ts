// Сортировка и фильтры над доской (pipeline-v2 §9.4). Сервер отдаёт колонки в порядке горячести; «По сроку» и «Новые
// сверху» переставляют карточки на устройстве (колонки «Новые» и «Перезвон»), остальные колонки не трогают. Чтобы порядок
// был честным, при такой сортировке колонка догружается до SORT_LIMIT карточек (useBoardData.fill); если их больше,
// остальные скрыты и показывается подсказка «уточните поиск» (load-pipeline-v2, C5).
import { isWorkingRole } from './columns';
import { BOARD_FILTERS, NO_EXTRA, type BoardCardDto, type BoardExtra, type BoardFilter, type BoardSort, type ColumnRole } from './types';

/** Предел колонки при сортировке на устройстве (§9.4, второй вариант). */
export const SORT_LIMIT = 200;

/** Колонка при сортировке на устройстве упёрлась в предел: «Ещё» убрано, вместо него подсказка «уточните поиск». */
export const sortLimited = (sort: BoardSort, role: ColumnRole, loaded: number, hasNext: boolean): boolean =>
  sort !== 'heat' && isWorkingRole(role) && hasNext && loaded >= SORT_LIMIT;

const stable = <T>(xs: readonly T[], key: (x: T) => number): T[] =>
  xs.map((x, i) => ({ x, i, k: key(x) })).sort((a, b) => a.k - b.k || a.i - b.i).map((e) => e.x);

/** «Новые сверху»: ни разу не набранные карточки впереди, внутри групп порядок сервера. */
const isFresh = (c: BoardCardDto): boolean => c.state === 'new' && c.attempts === 0 && c.callbackTouches === 0;

export function sortCards(cards: readonly BoardCardDto[], sort: BoardSort, role: ColumnRole): BoardCardDto[] {
  if (!isWorkingRole(role) || sort === 'heat') return [...cards];
  if (sort === 'due') return stable(cards, (c) => c.nextCallAt ?? Number.MAX_SAFE_INTEGER);
  return stable(cards, (c) => (isFresh(c) ? 0 : 1));
}

/** Фильтры, доступные зрителю: «Покупал» — только при праве на покупки (сервер иначе ответит 400). */
export function availableFilters(canPurchases: boolean): BoardFilter[] {
  return BOARD_FILTERS.filter((f) => f !== 'purchased' || canPurchases);
}

/** Запрос доски: `q` и `filter` — то, что понимает `GET /api/cards/board` (parseBoardQuery). */
export function boardQuery(q: string, filters: readonly BoardFilter[], extra: BoardExtra = NO_EXTRA): string {
  const sp = new URLSearchParams();
  const text = q.trim();
  if (text !== '') sp.set('q', text);
  if (filters.length > 0) sp.set('filter', filters.join(','));
  if (extra.owner !== '') sp.set('owner', extra.owner);
  if (extra.callbackReason !== '') sp.set('callbackReason', extra.callbackReason);
  return sp.toString();
}

/** Запрос «Ещё» по колонке: фильтры плюс ключ колонки и курсор (поиск колонки не сужает: он даёт отдельный список). */
export function columnQuery(column: string, cursor: string, filters: readonly BoardFilter[], extra: BoardExtra = NO_EXTRA): string {
  const sp = new URLSearchParams(boardQuery('', filters, extra));
  sp.set('column', column);
  sp.set('cursor', cursor);
  return sp.toString();
}
