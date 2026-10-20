// Каркас оболочки: шапка с колокольчиком, меню и область страницы. Оператор — нижняя панель на любом экране
// (работает с телефона); остальные роли — боковая колонка на ноутбуке и нижняя панель на телефоне.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BottomNav, NotificationBell, SideNav, type NavEntry } from './ShellNav';

export type AppShellProps = {
  variant: 'bottom' | 'side';
  brand: string;
  navLabel: string;
  items: readonly NavEntry[];
  bottomSlots: number;
  account: { href: string; label: string };
  /** Колокольчик: счётчик непрочитанных даёт P8a; пока 0 — бейджа нет. */
  bell: { href: string; label: string; count: number };
  more: { label: string; closeLabel: string };
  children: ReactNode;
};

export function AppShell({ variant, brand, navLabel, items, bottomSlots, account, bell, more, children }: AppShellProps) {
  const side = variant === 'side';
  return (
    <div className={`flex min-h-dvh flex-col ${side ? 'md:flex-row' : ''}`} style={{ background: 'var(--canvas)', color: 'var(--text)' }}>
      <aside
        className={`border-b ${side ? 'md:w-60 md:shrink-0 md:border-r md:border-b-0' : ''}`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className={`flex items-center justify-between gap-3 px-4 py-1 ${side ? 'md:flex-col md:items-start md:py-4' : ''}`}>
          <strong className="text-lg">{brand}</strong>
          <div className={`flex items-center gap-1 ${side ? 'md:w-full md:justify-between' : ''}`}>
            {side ? (
              <Link href={account.href} className="hidden min-h-11 items-center text-sm underline md:inline-flex">
                {account.label}
              </Link>
            ) : null}
            <NotificationBell {...bell} />
          </div>
        </div>
        {side ? <SideNav label={navLabel} items={items} /> : null}
      </aside>
      {/* Страницы ведут свой <main>; здесь только отступ под нижнюю панель с безопасной зоной iOS */}
      <div
        className={`min-w-0 flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] ${side ? 'px-4 py-4 md:px-8 md:py-6 md:pb-6' : ''}`}
      >
        {children}
      </div>
      <BottomNav
        label={navLabel}
        always={!side}
        items={items}
        slots={bottomSlots}
        more={{ label: more.label, closeLabel: more.closeLabel, account }}
      />
    </div>
  );
}
