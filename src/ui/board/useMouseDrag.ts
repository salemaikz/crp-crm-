'use client';

// Перетаскивание плитки мышью: нажали на плитке, повели — над колонками подсвечиваются цели, отпустили на доступной —
// вызывается onDrop. Только `pointerType === 'mouse'` и главная кнопка. Esc отменяет. Клик, которым закончилось
// перетаскивание, плитка не получает (иначе открылась бы шторка).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { edgeScroll, hitColumn, movedEnough, type ColumnRect, type Point } from './dnd';

export interface DragState {
  cardId: string;
  x: number;
  y: number;
  over: string | null;
}

export function useMouseDrag(opts: {
  enabled: boolean;
  scroller: RefObject<HTMLElement | null>;
  /** Можно ли начать перенос этой плитки (не заблокирована, есть цели). */
  canDrag: (cardId: string) => boolean;
  /** Можно ли отпустить плитку в колонку. */
  canDrop: (cardId: string, column: string) => boolean;
  onDrop: (cardId: string, column: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const startRef = useRef<{ cardId: string; at: Point } | null>(null);
  // Зеркало состояния: побочные действия (onDrop) не должны жить внутри функции-обновления setState
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);

  const rects = useCallback((): ColumnRect[] => {
    const root = optsRef.current.scroller.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('[data-column-key]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.columnKey ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
  }, []);

  const onPointerDown = useCallback((cardId: string, e: ReactPointerEvent) => {
    const o = optsRef.current;
    if (!o.enabled || e.pointerType !== 'mouse' || e.button !== 0) return;
    // Кнопки действий и поля ввода внутри плитки перетаскиванием не начинаются (у них data-no-drag)
    if ((e.target as HTMLElement).closest('input,select,textarea,[data-no-drag]')) return;
    if (!o.canDrag(cardId)) return;
    startRef.current = { cardId, at: { x: e.clientX, y: e.clientY } };
  }, []);

  useEffect(() => {
    if (!opts.enabled) return;
    let raf = 0;
    let last: Point = { x: 0, y: 0 };
    const loop = () => {
      const root = optsRef.current.scroller.current;
      if (root && startRef.current) {
        const box = root.getBoundingClientRect();
        const step = edgeScroll(last.x, box);
        if (step !== 0) root.scrollLeft += step;
      }
      raf = requestAnimationFrame(loop);
    };
    const move = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s || e.pointerType !== 'mouse') return;
      const p = { x: e.clientX, y: e.clientY };
      last = p;
      if (!dragRef.current && !movedEnough(s.at, p)) return;
      const key = hitColumn(p, rects());
      const over = key !== null && optsRef.current.canDrop(s.cardId, key) ? key : null;
      dragRef.current = { cardId: s.cardId, x: p.x, y: p.y, over };
      setDrag(dragRef.current);
    };
    const end = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      startRef.current = null;
      const was = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!was) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const key = hitColumn({ x: e.clientX, y: e.clientY }, rects());
      if (key !== null && optsRef.current.canDrop(s.cardId, key)) optsRef.current.onDrop(s.cardId, key);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !startRef.current) return;
      startRef.current = null;
      dragRef.current = null;
      setDrag(null);
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', key);
    };
  }, [opts.enabled, rects]);

  /** Обработчик клика плитки: съедает клик, которым закончилось перетаскивание. */
  const consumeClick = useCallback((): boolean => suppressClick.current, []);

  return { drag, onPointerDown, consumeClick };
}
