'use client';

// Высота ряда колонок до низа окна (ui-polish §9.2): хук ставит на элемент `--board-top` — расстояние от верха документа
// до ряда, а саму высоту считает CSS (`100dvh − верх − нижний отступ страницы`), потому что нижний отступ зависит от
// нижнего меню оболочки (`--bottom-nav-h`). Только на ширине ноутбука (≥ 768 px): на телефоне колонка идёт по странице.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const WIDE = '(min-width: 768px)';

export function useFillHeight(ref: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): void {
  const frame = useRef(0);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia(WIDE).matches) {
      el.style.removeProperty('--board-top');
      return;
    }
    // Верх ряда относительно документа: страница не прокручивается, но при первом показе она может стоять не вверху
    const top = el.getBoundingClientRect().top + window.scrollY;
    el.style.setProperty('--board-top', `${Math.max(0, Math.round(top))}px`);
  }, [ref]);

  // После каждой отрисовки (появился баннер над рядом — верх сдвинулся)
  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  useEffect(() => {
    const again = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', again);
    // Шапка над рядом (поиск, фильтры, баннеры) меняет высоту без смены окна
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again);
    const parent = ref.current?.parentElement;
    if (ro && parent) for (const child of Array.from(parent.children)) if (child !== ref.current) ro.observe(child);
    return () => {
      cancelAnimationFrame(frame.current);
      window.removeEventListener('resize', again);
      ro?.disconnect();
    };
  }, [measure, ref]);
}
