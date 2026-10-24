// Вид доски в адресе страницы (контракт К1, ui-polish §9.6): `tab`, `q`, `sort`, `f`, `owner`, `reason`. «Назад» из
// карточки и ссылки из сводки открывают тот же вид. Чистые функции: разбор молча отбрасывает всё, чего нет в конфиге
// доски (чужой сотрудник, незнакомая колонка, мусор), запись не пишет значения по умолчанию.
import { BOARD_SORTS, NO_EXTRA, type BoardExtra, type BoardFilter, type BoardSort } from './types';
import { BOARD_FILTERS } from './types';

/** Предел длины поиска в адресе (как у поля поиска доски). */
export const URL_Q_MAX = 100;

/** Что допустимо в адресе, из настроек доски и прав зрителя. */
export interface ViewLimits {
  /** Ключи колонок в порядке пресета; первая — вкладка по умолчанию. */
  tabs: readonly string[];
  /** Фильтры, доступные зрителю (`availableFilters`). */
  filters: readonly BoardFilter[];
  /** Сотрудники доски пространства; null — у доски оператора фильтра по сотруднику нет. */
  owners: readonly string[] | null;
  /** Ключи причин перезвона для доски пространства; null — фильтра нет. */
  reasons: readonly string[] | null;
}

export interface BoardView {
  tab: string;
  q: string;
  sort: BoardSort;
  filters: BoardFilter[];
  extra: BoardExtra;
}

type Params = { get(name: string): string | null };

export const defaultView = (lim: ViewLimits): BoardView => ({ tab: lim.tabs[0] ?? '', q: '', sort: 'heat', filters: [], extra: NO_EXTRA });

/** Разбор адреса: неизвестное значение отбрасывается, а не ломает доску. */
export function parseView(sp: Params, lim: ViewLimits): BoardView {
  const view = defaultView(lim);
  const tab = sp.get('tab');
  if (tab !== null && lim.tabs.includes(tab)) view.tab = tab;
  const q = (sp.get('q') ?? '').trim();
  if (q !== '' && q.length <= URL_Q_MAX) view.q = q;
  const sort = sp.get('sort');
  if (sort !== null && (BOARD_SORTS as readonly string[]).includes(sort)) view.sort = sort as BoardSort;
  const asked = new Set((sp.get('f') ?? '').split(',').map((x) => x.trim()));
  view.filters = BOARD_FILTERS.filter((f) => asked.has(f) && lim.filters.includes(f));
  const owner = sp.get('owner');
  if (owner !== null && lim.owners !== null && lim.owners.includes(owner)) view.extra = { ...view.extra, owner };
  const reason = sp.get('reason');
  if (reason !== null && lim.reasons !== null && lim.reasons.includes(reason)) view.extra = { ...view.extra, callbackReason: reason };
  return view;
}

/** Запись вида в строку адреса (без «?»); значения по умолчанию не пишутся, пустой вид — пустая строка. */
export function writeView(view: BoardView, lim: ViewLimits): string {
  const sp = new URLSearchParams();
  if (view.tab !== '' && view.tab !== lim.tabs[0]) sp.set('tab', view.tab);
  const q = view.q.trim();
  if (q !== '' && q.length <= URL_Q_MAX) sp.set('q', q);
  if (view.sort !== 'heat') sp.set('sort', view.sort);
  if (view.filters.length > 0) sp.set('f', view.filters.join(','));
  if (view.extra.owner !== '') sp.set('owner', view.extra.owner);
  if (view.extra.callbackReason !== '') sp.set('reason', view.extra.callbackReason);
  return sp.toString();
}

/** Сколько признаков вида включено сверх вкладки и сортировки: на кнопке «Фильтры · N» и в «Сбросить (N)». */
export function activeCount(view: Pick<BoardView, 'q' | 'filters' | 'extra'>): number {
  return view.filters.length + (view.extra.owner !== '' ? 1 : 0) + (view.extra.callbackReason !== '' ? 1 : 0) + (view.q.trim() !== '' ? 1 : 0);
}
