import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** Сетка из 12 колонок: поля одной группы (`Field width`) встают на общие вертикали. */
export function FormGrid({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('k-formgrid', className)} {...rest}>
      {children}
    </div>
  );
}

/** Строка фильтров: равные колонки, на телефоне по одному полю в строку. */
export function FilterBar({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={cn('k-filterbar', className)} {...rest}>
      {children}
    </div>
  );
}
