'use client';

// Перенос плитки долгим нажатием на телефоне (pipeline-v2 §9.2, этап В). Палец лёг на плитку и 350 мс не сдвинулся —
// плитка «поднимается» (лёгкая вибрация, где есть), прокрутка блокируется, вкладки колонок становятся целями. Палец
// сдвинулся раньше — это обычная прокрутка или свайп колонок, жест не перехватывается. Отпустили на цели — onDrop.
// Без библиотеки перетаскивания (D-352, уточняет D-347): события касания обработаны здесь; замена на библиотеку,
// если понадобится, не меняет внешний вид хука (те же canDrag/canDrop/onDrop).
import { useCallback, useEffect, useRef, useState, type RefObject, type TouchEvent as ReactTouchEvent } from 'react';
import { hitTarget, LONG_PRESS_MS, scrolledAway, type ColumnRect, type Point } from './dnd';
import type { DragState } from './useMouseDrag';

const rectsOf = (nodes: Iterable<HTMLElement>, attr: 'columnKey' | 'tabKey'): ColumnRect[] =>
  [...nodes].map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset[attr] ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });

export function useTouchDrag(opts: {
  enabled: boolean;
  scroller: RefObject<HTMLElement | null>;
  canDrag: (cardId: string) => boolean;
  canDrop: (cardId: string, column: string) => boolean;
  onDrop: (cardId: string, column: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const startRef = useRef<{ cardId: string; at: Point; id: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);

  const targetAt = useCallback((p: Point): string | null => {
    const o = optsRef.current;
    const tabs = rectsOf(document.querySelectorAll<HTMLElement>('[data-tab-key]'), 'tabKey');
    const columns = o.scroller.current ? rectsOf(o.scroller.current.querySelectorAll<HTMLElement>('[data-column-key]'), 'columnKey') : [];
    return hitTarget(p, tabs, columns);
  }, []);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const onTouchStart = useCallback((cardId: string, e: ReactTouchEvent) => {
    const o = optsRef.current;
    if (!o.enabled || e.touches.length !== 1) return;
    // Кнопки действий и поля ввода внутри плитки жест не начинают (у них data-no-drag)
    if ((e.target as HTMLElement).closest('input,select,textarea,[data-no-drag]')) return;
    if (!o.canDrag(cardId)) return;
    const t = e.touches[0]!;
    const at = { x: t.clientX, y: t.clientY };
    startRef.current = { cardId, at, id: t.identifier };
    clearTimer();
    timerRef.current = setTimeout(() => {
      const s = startRef.current;
      if (!s) return;
      const over = targetAt(s.at);
      dragRef.current = { cardId: s.cardId, x: s.at.x, y: s.at.y, over: over !== null && optsRef.current.canDrop(s.cardId, over) ? over : null };
      setDrag(dragRef.current);
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(15);
    }, LONG_PRESS_MS);
  }, [targetAt]);

  useEffect(() => {
    if (!opts.enabled) return;
    const find = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i++) if (list[i]!.identifier === id) return list[i]!;
      return null;
    };
    const reset = () => {
      clearTimer();
      startRef.current = null;
      dragRef.current = null;
      setDrag(null);
    };
    const move = (e: TouchEvent) => {
      const s = startRef.current;
      if (!s) return;
      const t = find(e.touches, s.id);
      if (!t) return;
      const p = { x: t.clientX, y: t.clientY };
      if (!dragRef.current) {
        // Ещё не «подняли»: сдвиг дальше допуска — это прокрутка, жест отдаём браузеру
        if (scrolledAway(s.at, p)) reset();
        return;
      }
      // Плитка поднята: страница и колонки под пальцем не прокручиваются
      if (e.cancelable) e.preventDefault();
      const key = targetAt(p);
      dragRef.current = { cardId: s.cardId, x: p.x, y: p.y, over: key !== null && optsRef.current.canDrop(s.cardId, key) ? key : null };
      setDrag(dragRef.current);
    };
    const end = (e: TouchEvent) => {
      const s = startRef.current;
      if (!s) return;
      const was = dragRef.current;
      const t = find(e.changedTouches, s.id);
      reset();
      if (!was) return;
      // Отпустили после переноса: следующий за касанием клик не должен открыть шторку
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 400);
      if (e.cancelable) e.preventDefault();
      const key = t ? targetAt({ x: t.clientX, y: t.clientY }) : null;
      if (key !== null && optsRef.current.canDrop(s.cardId, key)) optsRef.current.onDrop(s.cardId, key);
    };
    const cancel = () => reset();
    // Долгое нажатие на Android вызывает меню браузера: пока жест наш, его подавляем
    const menu = (e: Event) => {
      if (startRef.current) e.preventDefault();
    };
    window.addEventListener('contextmenu', menu);
    // passive: false — иначе браузер не даёт отменить прокрутку в touchmove
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end, { passive: false });
    window.addEventListener('touchcancel', cancel);
    return () => {
      clearTimer();
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', cancel);
      window.removeEventListener('contextmenu', menu);
    };
  }, [opts.enabled, targetAt]);

  /** Клик, которым закончился перенос, плитка не получает. */
  const consumeClick = useCallback((): boolean => suppressClick.current, []);

  return { drag, onTouchStart, consumeClick };
}
