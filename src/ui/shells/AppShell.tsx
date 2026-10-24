// Каркас оболочки: шапка с колокольчиком, меню и область страницы. Отступы и ширину страницы задаёт
// <Page> (D-319); оболочка только ставит data-shell и высоту нижнего меню (--bottom-nav-h). Все роли, включая оператора (D-353,
// ui-polish §9.8): боковая колонка на ≥ 768 px и нижняя панель на телефоне. Вариант `bottom` — панель на любом экране.
import type { ReactNode } from 'react';
import { PushSync } from '../push/PushSync';
import { ThemeSwitch, type ThemeSwitchProps } from '../theme/ThemeSwitch';
import { BoardTip, type BoardTipProps } from './BoardTip';
import { DesktopOnly } from './DesktopOnly';
import { DeviceOwnerGuard } from './DeviceOwnerGuard';
import type { BannerView } from './LicenseBannerBar';
import { BrandMark } from './BrandMark';
import { LogoutButton } from './LogoutButton';
import { ShellBanner } from './ShellBanner';
import { AccountLink, BottomNav, NotificationBell, SideNav, type NavEntry } from './ShellNav';
import type { MenuGroup } from './menu';

export type AppShellProps = {
  variant: 'bottom' | 'side';
  /** Название установки (org.productName, запасное — из локали) и адрес логотипа, если настроен (D-333). */
  brand: { name: string; logoSrc: string | null };
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
  /** Полоса состояния лицензии (P10b); null — нет. */
  banner?: BannerView | null;
  /** Личный переключатель вида (D-342); null — флаг THEME_DARK выключен, переключателя нет. */
  themeSwitch?: Omit<ThemeSwitchProps, 'compact'> | null;
  /** Подсказка первого входа на доску оператора (S4); null — нет (не оператор или доска выключена). */
  boardTip?: Omit<BoardTipProps, 'userId'> | null;
  children: ReactNode;
};

export function AppShell({ variant, brand, navLabel, items, groups, bottomSlots, account, bell, more, userId, outboxTtlMs, banner = null, themeSwitch = null, boardTip = null, children }: AppShellProps) {
  const side = variant === 'side';
  return (
    <div
      data-shell={variant}
      className={`flex min-h-dvh flex-col ${side ? 'md:flex-row' : ''}`}
      style={{ background: 'var(--canvas)', color: 'var(--text)' }}
    >
      <DeviceOwnerGuard userId={userId} outboxTtlMs={outboxTtlMs} />
      <PushSync userId={userId} />
      <aside
        className={`border-b ${side ? 'md:sticky md:top-0 md:flex md:h-dvh md:w-[var(--sidebar-w)] md:shrink-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0' : ''}`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', paddingTop: 'env(safe-area-inset-top)' }}
      >
        {/* Шапка: название или логотип на линии --gutter слева, колокольчик на линии --gutter справа */}
        <div className="flex min-h-14 items-center justify-between gap-3 px-[var(--gutter)] md:px-5">
          <BrandMark name={brand.name} logoSrc={brand.logoSrc} size={side ? 'side' : 'bar'} />
          <NotificationBell {...bell} />
        </div>
        {side && themeSwitch ? (
          <DesktopOnly>
            <div className="px-5 pb-2">
              <ThemeSwitch {...themeSwitch} compact />
            </div>
          </DesktopOnly>
        ) : null}
        {side ? <SideNav label={navLabel} items={items} groups={groups} /> : null}
        {side ? (
          <div className="mt-auto hidden md:block">
            <DesktopOnly>
              <div className="flex flex-col gap-1 border-t px-2 py-3" style={{ borderColor: 'var(--border)' }}>
                <AccountLink {...account} />
                <LogoutButton userId={userId} side />
              </div>
            </DesktopOnly>
          </div>
        ) : null}
      </aside>
      <div className="min-w-0 flex-1">
        <ShellBanner banner={banner} side={side} />
        {children}
      </div>
      {boardTip ? <BoardTip userId={userId} {...boardTip} /> : null}
      <BottomNav
        label={navLabel}
        always={!side}
        items={items}
        slots={bottomSlots}
        more={{
          label: more.label,
          closeLabel: more.closeLabel,
          account,
          logout: <LogoutButton userId={userId} />,
          // личный вид интерфейса (D-342): на телефоне в «Ещё», на ноутбуке выше, в боковой колонке
          extra: themeSwitch ? <ThemeSwitch {...themeSwitch} /> : null,
        }}
      />
    </div>
  );
}
