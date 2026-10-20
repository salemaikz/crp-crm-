import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Props = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'header' | 'footer' | 'nav' | 'main' | 'article';
  /** default — 1200 px; narrow — 760 px (формы, карточка клиента). */
  size?: 'default' | 'narrow';
  children?: ReactNode;
};

/** Контейнер страницы с боковыми отступами. */
export function Container({ as: Tag = 'div', size = 'default', className, children, ...rest }: Props) {
  return (
    <Tag className={cn('k-container', size === 'narrow' && 'k-container--narrow', className)} {...rest}>
      {children}
    </Tag>
  );
}
