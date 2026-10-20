'use client';
// Пункт меню оболочки: текущий раздел определяется по адресу, поэтому общий layout не знает путь страницы.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Пункт текущий, если адрес совпал или лежит внутри раздела (`/team` и `/team/x`). */
export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ManagerNavLink({ href, current, children }: { href: string; current?: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const active = current ?? isCurrentPath(pathname, href);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className="inline-flex min-h-11 items-center rounded-lg px-3 whitespace-nowrap aria-[current=page]:font-semibold"
      style={active ? { background: 'var(--brand-tint)', color: 'var(--brand-ink)' } : undefined}
    >
      {children}
    </Link>
  );
}
