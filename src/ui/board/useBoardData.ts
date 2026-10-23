'use client';

// Данные доски: первая страница каждой колонки, «Ещё» по ключу, поиск и фильтры на сервере, переносы «в уме».
// Токен запроса отбрасывает устаревшие ответы (быстрый набор в строке поиска). Данные доски нигде не сохраняются:
// ни в кэше service worker, ни в хранилище устройства (ПДн, ARCHITECTURE §7).
import { useCallback, useEffect, useRef, useState } from 'react';
import { boardQuery, columnQuery } from './order';
import { applyPlacements, type ColumnCards, type Placement } from './placement';
import type { BoardCardDto, BoardColumnPage, BoardDto, BoardFilter } from './types';

export type Phase = 'loading' | 'ready' | 'offline' | 'error' | 'unavailable' | 'login';

interface ColState {
  cards: BoardCardDto[];
  next: string | null;
  loadingMore: boolean;
}

const JSON_INIT = { cache: 'no-store' as const, credentials: 'same-origin' as const, headers: { Accept: 'application/json' } };

export function useBoardData(q: string, filters: readonly BoardFilter[], enabled: boolean, fetchFn: typeof fetch = fetch) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [board, setBoard] = useState<BoardDto | null>(null);
  const [cols, setCols] = useState<Record<string, ColState>>({});
  const [placements, setPlacements] = useState<Placement[]>([]);
  const token = useRef(0);
  const colsRef = useRef<Record<string, ColState>>({});
  const qRef = useRef({ q, filters });
  // Защищённый запрос экрана (общий телефон): держим в ref, чтобы колбэки не пересоздавались
  const fetchRef = useRef(fetchFn);
  useEffect(() => {
    qRef.current = { q, filters };
    fetchRef.current = fetchFn;
  });
  useEffect(() => {
    colsRef.current = cols;
  });

  const load = useCallback(async () => {
    const my = ++token.current;
    const { q: text, filters: fl } = qRef.current;
    try {
      const res = await fetchRef.current(`/api/cards/board?${boardQuery(text, fl)}`, JSON_INIT);
      if (my !== token.current) return;
      if (res.status === 401) return setPhase('login');
      if (res.status === 404) return setPhase('unavailable');
      if (!res.ok) return setPhase('error');
      const data = (await res.json()) as BoardDto;
      setBoard(data);
      const fresh = Object.fromEntries(data.columns.map((c) => [c.key, { cards: c.cards, next: c.next, loadingMore: false }]));
      setCols(fresh);
      setPhase('ready');
    } catch {
      if (my !== token.current) return;
      // Без сети остаётся последнее, что загружено на этой странице
      setPhase((p) => (p === 'ready' ? 'ready' : navigator.onLine ? 'error' : 'offline'));
    }
  }, []);

  // Поиск набирается: запрос уходит с небольшой задержкой; фильтры меняются реже, но идут тем же путём
  const key = `${q}|${filters.join(',')}`;
  useEffect(() => {
    if (!enabled) return;
    const h = setTimeout(() => void load(), q.trim() === '' ? 0 : 250);
    return () => clearTimeout(h);
    // key заменяет q и filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, load]);

  const more = useCallback(async (column: string) => {
    const cur = cols[column];
    if (!cur?.next || cur.loadingMore) return;
    setCols((c) => ({ ...c, [column]: { ...cur, loadingMore: true } }));
    const my = token.current;
    try {
      const res = await fetchRef.current(`/api/cards/board/column?${columnQuery(column, cur.next, qRef.current.filters)}`, JSON_INIT);
      if (!res.ok || my !== token.current) throw new Error(String(res.status));
      const page = (await res.json()) as BoardColumnPage;
      setCols((c) => {
        const prev = c[column] ?? cur;
        const ids = new Set(prev.cards.map((x) => x.id));
        return { ...c, [column]: { cards: [...prev.cards, ...page.cards.filter((x) => !ids.has(x.id))], next: page.next, loadingMore: false } };
      });
    } catch {
      setCols((c) => (c[column] ? { ...c, [column]: { ...c[column], loadingMore: false } } : c));
    }
  }, [cols]);

  /**
   * Догрузить колонку до `limit` карточек (сортировки на устройстве, §9.4: сервер отдаёт только порядок по горячести,
   * поэтому порядок «по сроку» честен лишь над целой колонкой). Страницы идут по курсору подряд; устаревший ответ
   * (сменились поиск или фильтры) обрывает цикл.
   */
  const fill = useCallback(async (column: string, limit: number) => {
    const my = token.current;
    let cur = colsRef.current[column];
    while (cur && cur.next && cur.cards.length < limit && my === token.current) {
      let page: BoardColumnPage;
      try {
        const res = await fetchRef.current(`/api/cards/board/column?${columnQuery(column, cur.next, qRef.current.filters)}`, JSON_INIT);
        if (!res.ok || my !== token.current) return;
        page = (await res.json()) as BoardColumnPage;
      } catch {
        return;
      }
      if (my !== token.current) return;
      const prev: ColState = colsRef.current[column] ?? cur;
      const ids = new Set(prev.cards.map((x) => x.id));
      const merged: ColState = { cards: [...prev.cards, ...page.cards.filter((x) => !ids.has(x.id))], next: page.next, loadingMore: false };
      colsRef.current = { ...colsRef.current, [column]: merged };
      setCols((c) => ({ ...c, [column]: merged }));
      cur = merged;
    }
  }, []);

  const place = useCallback((p: Placement) => setPlacements((xs) => [...xs.filter((x) => x.cardId !== p.cardId), p]), []);
  const unplaceCard = useCallback((cardId: string) => setPlacements((xs) => xs.filter((x) => x.cardId !== cardId)), []);
  const unplaceOps = useCallback((opIds: readonly string[]) => setPlacements((xs) => xs.filter((x) => !opIds.includes(x.opId))), []);
  /** Убрать плитку с экрана (404 «Карточка недоступна»). */
  const drop = useCallback((cardId: string) => {
    setCols((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, cards: v.cards.filter((x) => x.id !== cardId) }])));
  }, []);

  const raw: ColumnCards = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.cards]));
  const view = applyPlacements(raw, placements);

  return { phase, board, cols, view, placements, reload: load, more, fill, place, unplaceCard, unplaceOps, drop };
}
