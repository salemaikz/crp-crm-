import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Props = HTMLAttributes<HTMLElement> & {
  /** strip — равные колонки без рамок внутри одной карточки. */
  variant?: 'tiles' | 'strip';
  children?: ReactNode;
};

/** Плитки счётчиков (`Stat`): колонки одной ширины, у плиток в ряду одна высота. */
export function StatGrid({ variant = 'tiles', className, children, ...rest }: Props) {
  return (
    <section className={cn('k-statgrid', variant === 'strip' && 'k-statgrid--strip', className)} {...rest}>
      {children}
    </section>
  );
}
