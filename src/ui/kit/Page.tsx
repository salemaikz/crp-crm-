import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/**
 * Ширина страницы по её предмету (токены `--page-w-*`):
 * focus — один предмет внимания («Звонить», вход); form — формы и одна сущность; list — списки;
 * wide — таблицы и дашборды; full — во всю область (канбан).
 */
export type PageWidth = 'focus' | 'form' | 'list' | 'wide' | 'full';

type Props = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  width?: PageWidth;
  /** Шапка страницы (`<PageHeader>`): стоит первой в колонке. */
  header?: ReactNode;
  children?: ReactNode;
};

/**
 * Страница: единственное место, где задаются боковые отступы, ширина и нижний отступ под меню (D-319).
 * Своего `<main className="max-w-* px-*">` у страниц нет (статический тест).
 */
export function Page({ width = 'list', header, className, children, ...rest }: Props) {
  return (
    <main className={cn('k-page', `k-page--${width}`, className)} {...rest}>
      {header}
      {children}
    </main>
  );
}
