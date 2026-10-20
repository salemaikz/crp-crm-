// Источник: платформа LMS 2cd8a2b src/components/ui/TextLink.tsx (адаптировано под CRM)
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';
import { isExternalHref } from './href';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  children: ReactNode;
};

/** Ссылка в тексте: цвет бренда (читаемый, AA) и подчёркивание — не только цветом. */
export function TextLink({ href, className, children, ...rest }: Props) {
  const cls = cn('k-link', className);
  if (isExternalHref(href)) {
    return (
      <a href={href} className={cls} {...rest}>
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
