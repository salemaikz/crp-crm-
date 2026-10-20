// Оболочка руководителя и администратора: каркас навигации (R2a). Телефон — верхняя полоса с прокруткой,
// ноутбук — левая колонка. Пункты и подписи приходят от страницы: оболочка не знает модулей.
// Остальные пункты меню (сводка, карточки, отчёты…) добавляют свои задачи потока manager.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/ui/kit';
import { ManagerNavLink } from './ManagerNavLink';

export type ManagerNavItem = { href: string; label: string; current?: boolean };

type Props = {
  /** Название продукта в шапке. */
  brand: string;
  navLabel: string;
  nav: readonly ManagerNavItem[];
  /** Ссылка на личный кабинет (смена пароля, выход). */
  account: { href: string; label: string };
  children: ReactNode;
};

export function ManagerShell({ brand, navLabel, nav, account, children }: Props) {
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col md:flex-row" style={{ background: 'var(--canvas)', color: 'var(--text)' }}>
        <aside className="border-b md:w-60 md:shrink-0 md:border-r md:border-b-0" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <div className="flex items-center justify-between gap-3 px-4 py-2 md:flex-col md:items-start md:py-4">
            <strong className="text-lg">{brand}</strong>
            <Link href={account.href} className="inline-flex min-h-11 items-center text-sm underline">
              {account.label}
            </Link>
          </div>
          <nav aria-label={navLabel} className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-4">
            {nav.map((item) => (
              <ManagerNavLink key={item.href} href={item.href} current={item.current}>
                {item.label}
              </ManagerNavLink>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </ToastProvider>
  );
}
