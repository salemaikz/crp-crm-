'use client';

// Ширина ноутбука (≥ 768 px): шапка доски на телефоне и ноутбуке — разные элементы, а не один и тот же, спрятанный CSS,
// чтобы в странице не было двух одинаковых полей и кнопок (тесты, доступность). До гидратации — телефон.
import { useSyncExternalStore } from 'react';

const QUERY = '(min-width: 768px)';

function subscribe(cb: () => void): () => void {
  const m = window.matchMedia(QUERY);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
