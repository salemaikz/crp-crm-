// Источник: платформа LMS 2cd8a2b src/components/ui/Card.tsx (адаптировано под CRM)
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Props = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'article' | 'section' | 'aside' | 'li';
  /** solid — рамка 1 px; dashed — пунктир (место под добавление). */
  tone?: 'solid' | 'dashed';
  padding?: 'none' | 'md' | 'lg';
  /** Кликабельная карточка: фон при наведении. */
  interactive?: boolean;
  children?: ReactNode;
};

/** Карточка: плоская поверхность с рамкой, тени нет. */
export function Card({ as: Tag = 'div', tone = 'solid', padding = 'md', interactive, className, children, ...rest }: Props) {
  return (
    <Tag
      className={cn(
        'k-card',
        tone === 'dashed' && 'k-card--dashed',
        padding !== 'none' && `k-card--p-${padding}`,
        interactive && 'k-card--interactive',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
