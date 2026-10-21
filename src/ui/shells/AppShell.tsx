// Каркас оболочки: шапка с колокольчиком, меню и область страницы. Отступы и ширину страницы задаёт
// <Page> (D-319); оболочка только ставит data-shell и высоту нижнего меню (--bottom-nav-h). Оператор — нижняя панель на любом экране
// (работает с телефона); остальные роли — боковая колонка на ноутбуке и нижняя панель на телефоне.
import type { ReactNode } from 'react';
import { DeviceOwnerGuard } from './DeviceOwnerGuard';
import { LogoutButton } from './LogoutButton';
import { AccountLink, BottomNav, NotificationBell, SideNav, type NavEntry } from './ShellNav';
import type { MenuGroup } from './menu';

export type AppShellProps = {
  variant: 'bottom' | 'side';
  /** Название установки: org.productName из настроек (запасное — из локали). */
  brand: string;
  navLabel: string;
  items: readonly NavEntry[];
  /** Подписи групп бокового меню. */
  groups: Record<MenuGroup, string>;
  bottomSlots: number;
  account: { href: string; label: string };
  /** Колокольчик: счётчик непрочитанных даёт P8a; пока 0 — бейджа нет. */
  bell: { href: string; label: string; count: number };
  more: { label: string; closeLabel: string };
  /** Сотрудник: нужен кнопке «Выйти», чтобы отправить его неотправленные итоги. */
  userId: string;
  /** Срок итогов другого сотрудника на телефоне, мс (D-293); null — не удалять. */
  outboxTtlMs: number | null;
  children: ReactNode;
};

export function AppShell({ variant, brand, navLabel, items, groups, bottomSlots, account, bell, more, userId, outboxTtlMs, children }: AppShellProps) {
  const side = variant === 'side';
  return (
    <div
      data-shell={variant}
      className={`flex min-h-dvh flex-col ${side ? 'md:flex-row' : ''}`}
      style={{ background: 'var(--canvas)', color: 'var(--text)' }}
    >
      <DeviceOwnerGuard userId={userId} outboxTtlMs={outboxTtlMs} />
      <aside
        className={`border-b ${side ? 'md:sticky md:top-0 md:flex md:h-dvh md:w-[var(--sidebar-w)] md:shrink-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0' : ''}`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', paddingTop: 'env(safe-area-inset-top)' }}
      >
        {/* Шапка: название на линии --gutter слева, колокольчик на линии --gutter справа */}
        <div className="flex min-h-14 items-center justify-between gap-3 px-[var(--gutter)] md:px-5">
          <strong className="min-w-0 truncate text-lg" data-testid="shell-brand">
            {brand}
          </strong>
          <NotificationBell {...bell} />
        </div>
        {side ? <SideNav label={navLabel} items={items} groups={groups} /> : null}
        {side ? (
          <div className="mt-auto hidden flex-col gap-1 border-t px-2 py-3 md:flex" style={{ borderColor: 'var(--border)' }}>
            <AccountLink {...account} />
            <LogoutButton userId={userId} side />
          </div>
        ) : null}
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
      <BottomNav
        label={navLabel}
        always={!side}
        items={items}
        slots={bottomSlots}
        more={{ label: more.label, closeLabel: more.closeLabel, account, logout: <LogoutButton userId={userId} /> }}
      />
    </div>
  );
}
