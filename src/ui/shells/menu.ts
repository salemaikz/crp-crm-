// Меню оболочек по ролям: чистая функция без сервера и Next. Каталог пунктов ведёт интерфейс
// (RoleSchema.menu: «список пунктов ведёт интерфейс»); роль настроек отбирает пункты ключами `menu`,
// права Viewer — разрешениями `perm`. Пункт виден, если выполнены оба условия и включён флаг модуля.
import type { Permission } from '@crm/core/access';

export type ShellKind = 'operator' | 'manager' | 'consultant' | 'duty';

/** Идентификатор пункта: он же ключ подписи `shell.nav.<id>` и иконки. */
export type MenuId =
  | 'call' | 'clients' | 'tasks' | 'bookings' | 'archive' | 'myDay'
  | 'summary' | 'distribution' | 'cards' | 'kanban' | 'reports' | 'settings' | 'pool' | 'import' | 'handoffs' | 'team'
  | 'consultations' | 'duty' | 'integrations';

export type MenuItem = { id: MenuId; href: string };

type CatalogItem = {
  id: MenuId;
  href: string;
  /** Ключи `roles[].menu`, любой из которых включает пункт; нет списка — пункт определяется только правами. */
  keys?: readonly string[];
  perm?: Permission;
  /** Флаг модуля (FEATURE_<NAME>): выключен — пункт скрыт. */
  feature?: string;
  /** Только администратор установки (раздел сам проверяет это же право). */
  adminOnly?: boolean;
};

type ShellSpec = {
  /** Сколько пунктов стоит в нижней панели до кнопки «Ещё». */
  bottomSlots: number;
  items: readonly CatalogItem[];
};

// Порядок — порядок в меню. Остальные пункты на телефоне уходят в «Ещё».
const SHELLS: Record<ShellKind, ShellSpec> = {
  // Оператор: телефон, «Звонить / Клиенты / Задачи / Ещё»
  operator: {
    bottomSlots: 3,
    items: [
      { id: 'call', href: '/call', keys: ['queue'], perm: 'card.read' },
      { id: 'clients', href: '/clients', perm: 'client.read' },
      { id: 'tasks', href: '/tasks', keys: ['tasks'], perm: 'task.read' },
      { id: 'bookings', href: '/bookings', keys: ['bookings'], perm: 'booking.read' },
      { id: 'archive', href: '/archive', keys: ['archive'], perm: 'card.read' },
      { id: 'myDay', href: '/my-day', keys: ['my_day'], perm: 'card.read' },
    ],
  },
  // РОП, директор, руководитель, наблюдатель, отдел маркетинга: ноутбук, боковая навигация
  manager: {
    bottomSlots: 4,
    items: [
      { id: 'summary', href: '/summary', keys: ['summary', 'dashboard'], perm: 'report.view' },
      { id: 'handoffs', href: '/handoffs', keys: ['handoffs'], perm: 'handoff.read' },
      { id: 'distribution', href: '/distribution', keys: ['distribution'], perm: 'distribution.manage' },
      { id: 'cards', href: '/cards', keys: ['cards'], perm: 'card.read' },
      { id: 'clients', href: '/clients', perm: 'client.read' },
      { id: 'bookings', href: '/bookings', keys: ['bookings'], perm: 'booking.read' },
      { id: 'kanban', href: '/deals', keys: ['deals'], perm: 'deal.read', feature: 'KANBAN' },
      { id: 'reports', href: '/reports', keys: ['reports'], perm: 'report.view' },
      { id: 'settings', href: '/settings', keys: ['settings'], perm: 'settings.sales' },
      { id: 'pool', href: '/pool', keys: ['pool'], perm: 'pool.read' },
      { id: 'tasks', href: '/tasks', keys: ['tasks'], perm: 'task.read' },
      { id: 'import', href: '/import', keys: ['import'], perm: 'import.run', feature: 'IMPORT' },
      { id: 'team', href: '/team', adminOnly: true },
      { id: 'integrations', href: '/integrations', adminOnly: true, feature: 'WAZZUP' },
    ],
  },
  // Консультант: свои консультации, задачи, день
  consultant: {
    bottomSlots: 3,
    items: [
      { id: 'consultations', href: '/consultations', keys: ['consultations'], perm: 'booking.read' },
      { id: 'tasks', href: '/tasks', keys: ['tasks'], perm: 'task.read' },
      { id: 'myDay', href: '/my-day', keys: ['my_day'], perm: 'booking.read' },
    ],
  },
  // Дежурный по встрече: явка гостей на встрече (отношение duty_today), без ключей меню роли
  duty: {
    bottomSlots: 3,
    items: [
      { id: 'duty', href: '/duty', perm: 'booking.attend' },
      { id: 'bookings', href: '/bookings', perm: 'booking.read' },
      { id: 'clients', href: '/clients', perm: 'client.read' },
    ],
  },
};

/** Какая оболочка у роли: по ключам её меню. Нет роли (например, администратор) — менеджерская. */
export function shellKindOf(menu: readonly string[]): ShellKind {
  if (menu.includes('queue')) return 'operator';
  if (menu.includes('consultations')) return 'consultant';
  return 'manager';
}

export type MenuInput = {
  shell: ShellKind;
  /** `roles[].menu` роли зрителя; пусто — роли нет. */
  menu: readonly string[];
  can: (perm: Permission) => boolean;
  isAdmin: boolean;
  /** Включённые флаги модулей (имена без `FEATURE_`). */
  features?: ReadonlySet<string>;
};

export type BuiltMenu = {
  shell: ShellKind;
  items: readonly MenuItem[];
  /** Сколько первых пунктов стоит в нижней панели телефона; остальные — в «Ещё». */
  bottomSlots: number;
  /** Главная роли: первый видимый пункт; пунктов нет — личный кабинет. */
  home: string;
};

export function buildMenu(input: MenuInput): BuiltMenu {
  const spec = SHELLS[input.shell];
  const seen = new Set<string>();
  const items: MenuItem[] = [];
  for (const it of spec.items) {
    if (it.adminOnly && !input.isAdmin) continue;
    if (it.keys && !it.keys.some((k) => input.menu.includes(k))) continue;
    if (it.perm && !input.can(it.perm)) continue;
    if (it.feature && !input.features?.has(it.feature)) continue;
    if (seen.has(it.href)) continue;
    seen.add(it.href);
    items.push({ id: it.id, href: it.href });
  }
  return { shell: input.shell, items, bottomSlots: spec.bottomSlots, home: items[0]?.href ?? '/account' };
}

/** Пункт текущий, если адрес совпал или лежит внутри раздела (`/clients` и `/clients/x`). */
export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
