// Источник: платформа LMS 2cd8a2b src/components/ui/Breadcrumbs.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';

export type Crumb = { label: ReactNode; href?: string };

type Props = {
  items: Crumb[];
  /** aria-label навигации (из локали). */
  label: string;
  className?: string;
};

/** Хлебные крошки. Последний пункт — текущая страница. */
export function Breadcrumbs({ items, label, className }: Props) {
  return (
    <nav aria-label={label} className={cn('k-crumbs', className)}>
      <ol>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i}>
              {item.href && !last ? (
                <Link href={item.href}>{item.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
