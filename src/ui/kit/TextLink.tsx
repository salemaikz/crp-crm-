// Источник: платформа LMS 2cd8a2b src/components/ui/TextLink.tsx (адаптировано под CRM)
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';
import { isExternalHref } from './href';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  children: ReactNode;
};

/**
 * rel внешней ссылки: у http(s) и «//» всегда noopener noreferrer — адрес CRM с id объектов
 * не уходит в Referer (D-051). Якорь, mailto и tel остаются как заданы.
 */
export function externalRel(href: string, rel?: string): string | undefined {
  if (!/^(https?:|\/\/)/i.test(href)) return rel;
  const set = new Set((rel ?? '').split(/\s+/).filter(Boolean));
  set.add('noopener');
  set.add('noreferrer');
  return [...set].join(' ');
}

/** Ссылка в тексте: цвет бренда (читаемый, AA) и подчёркивание — не только цветом. */
export function TextLink({ href, className, children, ...rest }: Props) {
  const cls = cn('k-link', className);
  if (isExternalHref(href)) {
    const { rel, ...other } = rest;
    return (
      <a href={href} className={cls} {...other} rel={externalRel(href, rel)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}
