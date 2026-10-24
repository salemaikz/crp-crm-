'use client';
// Содержимое боковой колонки, нужное только на ≥ 768 px (тема, аккаунт, выход). На телефоне оно не монтируется:
// те же действия лежат в листе «Ещё», и в странице не бывает двух одинаковых кнопок «Выйти». Пока страница
// не гидрирована, на сервере и в первом кадре содержимого нет, на ноутбуке оно появляется сразу после гидрации.
import { useSyncExternalStore, type ReactNode } from 'react';

const QUERY = '(min-width: 768px)';

const subscribe = (cb: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};

export function DesktopOnly({ children }: { children: ReactNode }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  return wide ? <>{children}</> : null;
}
