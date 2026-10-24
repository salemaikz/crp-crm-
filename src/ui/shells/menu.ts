// Меню оболочек по ролям: чистая функция без сервера и Next. Каталог пунктов ведёт интерфейс
// (RoleSchema.menu: «список пунктов ведёт интерфейс»); роль настроек отбирает пункты ключами `menu`,
// права Viewer — разрешениями `perm`. Пункт виден, если выполнены оба условия и включён флаг модуля.
import type { Permission } from '@crm/core/access';

export type ShellKind = 'operator' | 'manager' | 'consultant' | 'duty';

/** Идентификатор пункта: он же ключ подписи `shell.nav.<id>` и иконки. */
export type MenuId =
  | 'board' | 'purchases' | 'call' | 'clients' | 'tasks' | 'bookings' | 'archive' | 'help'
  | 'summary' | 'director' | 'exports' | 'distribution' | 'kanban' | 'reports' | 'settings' | 'import' | 'handoffs' | 'team' | 'transfer'
  | 'consultations' | 'duty' | 'integrations';

export type MenuItem = { id: MenuId; href: string };

/** Группа пункта в боковой колонке: подпись — `shell.group.<id>`. Порядок пунктов и права группы не меняют. */
export type MenuGroup = 'work' | 'analytics' | 'manage';
export const MENU_GROUPS: readonly MenuGroup[] = ['work', 'analytics', 'manage'];

export const MENU_GROUP: Record<MenuId, MenuGroup> = {
  board: 'work', purchases: 'work', call: 'work', clients: 'work', tasks: 'work', bookings: 'work', archive: 'work', summary: 'work', director: 'work',
  distribution: 'work', handoffs: 'work', kanban: 'work', consultations: 'work', duty: 'work', help: 'work',
  reports: 'analytics', exports: 'analytics',
  settings: 'manage', import: 'manage', transfer: 'manage', team: 'manage', integrations: 'manage',
};

type CatalogItem = {
  id: MenuId;
  href: string;
  /** Ключи `roles[].menu`, любой из которых включает пункт; нет списка — пункт определяется только правами. */
  keys?: readonly string[];
  perm?: Permission;
  /** Страница пускает только охват пространства и шире (сервис отчётов): узкому охвату пункт не показываем. */
  spaceReports?: boolean;
  /** Страница пускает охват карточек «пространство» и шире (доска РОП): узкому охвату пункт не показываем. */
  wideCards?: boolean;
  /** Флаг модуля (FEATURE_<NAME>): выключен — пункт скрыт. */
  feature?: string;
  /** Второй обязательный флаг: страница доски РОП до влития A8 отвечает 404 без KANBAN, пункт на 404 не ведёт. */
  alsoFeature?: string;
  /** Обратный флаг: пункт виден, только пока модуль выключен (запасной вход в раздел, D-295). */
  unlessFeature?: string;
  /** Только администратор установки (раздел сам проверяет это же право). */
  adminOnly?: boolean;
  /** Пункт виден и администратору установки независимо от меню роли и прав (раздел сам проверяет доступ). */
  orAdmin?: boolean;
};

type ShellSpec = {
  /** Сколько пунктов стоит в нижней панели до кнопки «Ещё». */
  bottomSlots: number;
  items: readonly CatalogItem[];
};

// Порядок — порядок в меню. Остальные пункты на телефоне уходят в «Ещё».
const SHELLS: Record<ShellKind, ShellSpec> = {
  // Оператор: телефон, «Звонить / Клиенты / Задачи / Ещё»; при OP_BOARD — «Доска / Звонить / Задачи / Ещё», а «Клиенты»
  // скрыты: их заменяет поиск над доской (pipeline-v2 §9.1)
  operator: {
    bottomSlots: 3,
    items: [
      { id: 'board', href: '/board', keys: ['queue'], perm: 'card.outcome', feature: 'OP_BOARD' },
      { id: 'call', href: '/call', keys: ['queue'], perm: 'card.read' },
      { id: 'clients', href: '/clients', perm: 'client.read', unlessFeature: 'OP_BOARD' },
      { id: 'tasks', href: '/tasks', keys: ['tasks'], perm: 'task.read' },
      { id: 'bookings', href: '/bookings', keys: ['bookings'], perm: 'booking.read' },
      { id: 'archive', href: '/archive', keys: ['archive'], perm: 'client.read' },
      // «Мои покупки» (К4): сделки по заслуге; на телефоне уходят в «Ещё»
      { id: 'purchases', href: '/board/purchases', perm: 'deal.read', feature: 'OP_BOARD' },
      { id: 'help', href: '/help', feature: 'OP_BOARD' },
    ],
  },
  // РОП, директор, руководитель, наблюдатель, отдел маркетинга: ноутбук, боковая навигация
  manager: {
    bottomSlots: 4,
    items: [
      { id: 'summary', href: '/summary', keys: ['summary'], perm: 'report.view', spaceReports: true },
      { id: 'director', href: '/director', keys: ['dashboard'], perm: 'report.view', spaceReports: true, feature: 'REPORTS' },
      // Доска обзвона РОП (К5): пока A8 не влита, страница требует и KANBAN; только охват карточек «пространство» и шире
      { id: 'board', href: '/deals/calling', perm: 'card.read', wideCards: true, feature: 'OP_BOARD', alsoFeature: 'KANBAN' },
      { id: 'handoffs', href: '/handoffs', keys: ['handoffs'], perm: 'handoff.read', feature: 'PURCHASES' },
      { id: 'distribution', href: '/distribution', keys: ['distribution', 'pool'], perm: 'pool.read' },
      { id: 'clients', href: '/clients', perm: 'client.read' },
      { id: 'bookings', href: '/bookings', keys: ['bookings'], perm: 'booking.read' },
      { id: 'kanban', href: '/deals', keys: ['deals'], perm: 'deal.read', feature: 'KANBAN' },
      { id: 'reports', href: '/reports', keys: ['reports'], perm: 'report.view', spaceReports: true, feature: 'REPORTS' },
      // отчёты выключены, а полная выгрузка — нет (D-055, D-295): её кнопка остаётся на /reports
      { id: 'reports', href: '/reports', keys: ['reports'], perm: 'data.export_all', unlessFeature: 'REPORTS' },
      { id: 'exports', href: '/reports/exports', keys: ['reports'], perm: 'export.journal', orAdmin: true },
      { id: 'settings', href: '/settings', keys: ['settings'], perm: 'settings.sales', orAdmin: true, feature: 'SALES_SETTINGS' },
      { id: 'tasks', href: '/tasks', keys: ['tasks'], perm: 'task.read' },
      { id: 'import', href: '/import', keys: ['import'], perm: 'import.run', feature: 'IMPORT' },
      { id: 'transfer', href: '/team/transfer', keys: ['distribution'], perm: 'client.transfer', feature: 'BULK_TRANSFER' },
      { id: 'team', href: '/team', adminOnly: true },
      { id: 'integrations', href: '/integrations', adminOnly: true },
      { id: 'help', href: '/help', feature: 'OP_BOARD' },
    ],
  },
  // Консультант: свои консультации и задачи (день — группы «Сегодня / Завтра» на /consultations, D-313)
  consultant: {
    bottomSlots: 3,
    items: [
      { id: 'consultations', href: '/consultations', keys: ['consultations'], perm: 'booking.read', feature: 'BK_WIZARD' },
      { id: 'tasks', href: '/tasks', keys: ['tasks'], perm: 'task.read' },
      { id: 'help', href: '/help', feature: 'OP_BOARD' },
    ],
  },
  // Дежурный по встрече: явка гостей на встрече (отношение duty_today), без ключей меню роли
  duty: {
    bottomSlots: 3,
    items: [
      { id: 'duty', href: '/duty', perm: 'booking.attend' },
      { id: 'bookings', href: '/bookings', perm: 'booking.read' },
      { id: 'clients', href: '/clients', perm: 'client.read' },
      { id: 'help', href: '/help', feature: 'OP_BOARD' },
    ],
  },
};

/** Ключи `roles[].menu`, которые что-то включают в каталоге (страж: в пресетах нет мёртвых ключей). */
export const MENU_KEYS: ReadonlySet<string> = new Set(
  Object.values(SHELLS).flatMap((sh) => sh.items.flatMap((it) => it.keys ?? [])),
);

/** Вид каркаса: оператор получает боковую колонку на ноутбуке только при OP_BOARD (без флага — прежняя нижняя панель). */
export function shellVariantOf(shell: ShellKind, features: ReadonlySet<string>): 'bottom' | 'side' {
  return shell === 'operator' && !features.has('OP_BOARD') ? 'bottom' : 'side';
}

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
  /** Охват зрителя достаточен для отчётов (`canSpaceReports` сервиса отчётов); без него пункты отчётов скрыты. */
  spaceReports: boolean;
  /** Охват `card.read` — пространство и шире (как `showCalling` на /deals); без него пункт доски РОП скрыт. */
  wideCards?: boolean;
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
  const byRoleHrefs: string[] = [];
  for (const it of spec.items) {
    if (it.adminOnly && !input.isAdmin) continue;
    const adminPass = it.orAdmin === true && input.isAdmin;
    const byRole = (!it.keys || it.keys.some((k) => input.menu.includes(k))) && (!it.perm || input.can(it.perm)) &&
      (!it.spaceReports || input.spaceReports) && (!it.wideCards || input.wideCards === true);
    if (!byRole && !adminPass) continue;
    if (it.feature && !input.features?.has(it.feature)) continue;
    if (it.alsoFeature && !input.features?.has(it.alsoFeature)) continue;
    if (it.unlessFeature && input.features?.has(it.unlessFeature)) continue;
    if (seen.has(it.href)) continue;
    seen.add(it.href);
    items.push({ id: it.id, href: it.href });
    // пункт, открытый администратору только исключением orAdmin, главной не становится
    if ((byRole || it.adminOnly) && it.id !== 'help') byRoleHrefs.push(it.href);
  }
  return { shell: input.shell, items, bottomSlots: spec.bottomSlots, home: byRoleHrefs[0] ?? items.find((i) => i.id !== 'help')?.href ?? '/account' };
}

/** Текущий пункт среди всех: из совпавших побеждает самый длинный href (`/reports/exports` — не «Отчёты»). */
export function currentHref(pathname: string | null, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const h of hrefs) if (isCurrentPath(pathname, h) && (best === null || h.length > best.length)) best = h;
  return best;
}

/** Пункт текущий, если адрес совпал или лежит внутри раздела (`/clients` и `/clients/x`). */
export function isCurrentPath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
