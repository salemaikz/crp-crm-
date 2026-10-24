'use client';
// Навигация оболочки: боковая колонка (ноутбук) и нижняя панель с «Ещё» (телефон). Текущий раздел
// определяется по адресу, поэтому компоненты клиентские; подписи приходят готовыми из локали.
import {
  Archive, ArrowRightLeft, Bell, CalendarDays, ChartColumn, CircleQuestionMark, Columns3, Ellipsis, Forward, Handshake, Headset, Kanban,
  FileDown, Gauge, LayoutDashboard, ListChecks, Phone, PlugZap, Settings, Shuffle, ShoppingBag, Upload, UserCheck, User, UserCog, Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { BottomSheet } from '@/ui/kit';
import { MENU_GROUPS, currentHref, type MenuGroup, type MenuId } from './menu';

export type NavEntry = { id: MenuId; href: string; label: string; group: MenuGroup };

const ICONS: Record<MenuId, LucideIcon> = {
  board: Columns3, purchases: ShoppingBag, help: CircleQuestionMark, call: Phone, clients: Users, tasks: ListChecks, bookings: CalendarDays, archive: Archive,
  summary: LayoutDashboard, director: Gauge, exports: FileDown, distribution: Shuffle, kanban: Kanban, reports: ChartColumn,
  settings: Settings, import: Upload, handoffs: ArrowRightLeft, team: UserCog, transfer: Forward,
  consultations: Headset, duty: UserCheck, integrations: PlugZap,
};
// Запасной значок на случай нового MenuId без записи выше
const FALLBACK_ICON = Handshake;

function iconOf(id: MenuId): LucideIcon {
  return ICONS[id] ?? FALLBACK_ICON;
}

const sideLink =
  'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 whitespace-nowrap aria-[current=page]:font-semibold';
const activeStyle = { background: 'var(--brand-tint)', color: 'var(--brand-ink)' } as const;

/** Боковая навигация: ноутбук. Пункты по группам с короткой подписью; пустая группа не показывается. */
export function SideNav({ label, items, groups }: { label: string; items: readonly NavEntry[]; groups: Record<MenuGroup, string> }) {
  const pathname = usePathname();
  const current = currentHref(pathname, items.map((i) => i.href));
  return (
    <nav aria-label={label} className="hidden flex-col gap-1 px-2 pb-4 md:flex">
      {MENU_GROUPS.map((g) => {
        const inGroup = items.filter((i) => i.group === g);
        if (inGroup.length === 0) return null;
        return (
          <div key={g} role="group" aria-label={groups[g]} className="flex flex-col gap-1">
            <p className="px-3 pt-3 pb-1 text-xs font-semibold" style={{ color: 'var(--text-3)' }}>
              {groups[g]}
            </p>
            {inGroup.map((item) => {
              const active = item.href === current;
              const Icon = iconOf(item.id);
              return (
                <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={sideLink} style={active ? activeStyle : undefined}>
                  <Icon size={18} aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

/** «Мой аккаунт» внизу боковой колонки: пункт меню по левому краю со значком. */
export function AccountLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = currentHref(pathname, [href]) === href;
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={sideLink} style={active ? activeStyle : undefined}>
      <User size={18} aria-hidden="true" />
      {label}
    </Link>
  );
}

type BottomProps = {
  label: string;
  /** Видна ли панель на широком экране: у оператора — да, у остальных только на телефоне. */
  always: boolean;
  /** Все пункты меню: первые `slots` стоят в панели, остальные уходят в «Ещё». */
  items: readonly NavEntry[];
  slots: number;
  more: { label: string; closeLabel: string; account: { href: string; label: string }; logout: ReactNode; extra?: ReactNode };
};

const slot = 'flex min-h-11 min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-1 py-1 text-xs aria-[current=page]:font-semibold';
const sheetLink = 'flex min-h-11 items-center gap-3 rounded-lg px-2 aria-[current=page]:font-semibold';

/** Нижняя панель телефона: первые пункты и «Ещё» (остальные пункты и личный кабинет). */
export function BottomNav({ label, always, items, slots, more }: BottomProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const shown = items.slice(0, slots);
  const rest = items.slice(slots);
  const current = currentHref(pathname, [...items.map((i) => i.href), more.account.href]);
  const moreActive = rest.some((i) => i.href === current) || current === more.account.href;
  return (
    <>
      <nav
        aria-label={label}
        className={`fixed inset-x-0 bottom-0 z-30 flex border-t ${always ? '' : 'md:hidden'}`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', height: 'var(--bottom-nav-h)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {shown.map((item) => {
          const active = item.href === current;
          const Icon = iconOf(item.id);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={slot}
              style={{ color: active ? 'var(--brand-ink)' : 'var(--text-2)' }}
            >
              <Icon size={22} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          className={slot}
          style={{ color: moreActive ? 'var(--brand-ink)' : 'var(--text-2)' }}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Ellipsis size={22} aria-hidden="true" />
          {more.label}
        </button>
      </nav>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={more.label} closeLabel={more.closeLabel}>
        <ul className="flex flex-col">
          {rest.map((item) => {
            const Icon = iconOf(item.id);
            return (
              <li key={item.href}>
                <Link href={item.href} className={sheetLink} aria-current={item.href === current ? 'page' : undefined} onClick={() => setOpen(false)}>
                  <Icon size={20} aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
          <li>
            <Link href={more.account.href} className={sheetLink} onClick={() => setOpen(false)}>
              <User size={20} aria-hidden="true" />
              {more.account.label}
            </Link>
          </li>
          {more.extra ? <li className="px-2 py-2">{more.extra}</li> : null}
          <li>{more.logout}</li>
        </ul>
      </BottomSheet>
    </>
  );
}

/** Колокольчик уведомлений: место под P8a; бейдж скрыт, пока счётчик 0. */
export function NotificationBell({ href, label, count }: { href: string; label: string; count: number }) {
  return (
    <Link href={href} aria-label={count > 0 ? `${label}: ${count}` : label} className="relative -mr-3 inline-flex min-h-11 min-w-11 items-center justify-center md:mr-0">
      <Bell size={20} aria-hidden="true" />
      {count > 0 ? (
        <span
          className="absolute top-1.5 right-1.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold"
          style={{ background: 'var(--brand)', color: 'var(--on-brand)' }}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
