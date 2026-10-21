import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Все кнопки одной ширины («Пришёл / Не пришёл», «Карточка / Пропустить»). */
  equal?: boolean;
  /** end — ряд прижат к правому краю. */
  align?: 'start' | 'end';
  children?: ReactNode;
};

/**
 * Ряд кнопок. Опасное действие, отделённое от остальных, получает `className={ACTION_SEPARATE}`:
 * оно уходит на противоположный край ряда.
 */
export function ActionBar({ equal, align = 'start', className, children, ...rest }: Props) {
  return (
    <div className={cn('k-actionbar', equal && 'k-actionbar--equal', align === 'end' && 'k-actionbar--end', className)} {...rest}>
      {children}
    </div>
  );
}

/** Класс для опасного действия в `ActionBar`, которое уходит на противоположный край. */
export const ACTION_SEPARATE = 'k-actionbar__separate';
