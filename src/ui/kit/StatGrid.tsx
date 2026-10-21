import { Children, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { statCols } from './statCols';

type Props = HTMLAttributes<HTMLElement> & {
  /** strip — равные колонки без рамок внутри одной карточки. */
  variant?: 'tiles' | 'strip';
  /** Плиток в ряду; по умолчанию — по их числу без дыры в последнем ряду (`statCols`). */
  cols?: number;
  children?: ReactNode;
};

/** Плитки счётчиков (`Stat`): колонки одной ширины, у плиток в ряду одна высота, ряды без дыр. */
export function StatGrid({ variant = 'tiles', cols, className, style, children, ...rest }: Props) {
  const n = cols ?? statCols(Children.toArray(children).length);
  return (
    <section className={cn('k-statgrid', variant === 'strip' && 'k-statgrid--strip', className)} style={{ '--stat-cols': n, ...style } as CSSProperties} {...rest}>
      {children}
    </section>
  );
}
