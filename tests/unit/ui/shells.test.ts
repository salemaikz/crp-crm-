// Оболочки по ролям (P9b): меню каждой роли пресетов base и crp, скрытие по правам, флагам и администратору.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleConfig } from '@crm/core/access';
import { can } from '../../../src/server/access/viewer';
import { testViewer } from '../../../src/server/access/testing';
import { canSpaceReports } from '../../../src/server/domain/reports/access';
import { buildMenu, currentHref, isCurrentPath, shellKindOf, type ShellKind } from '../../../src/ui/shells/menu';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function rolesOf(preset: string): RoleConfig[] {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', preset, 'preset.json'), 'utf8')) as { global: { roles: RoleConfig[] } };
  return doc.global.roles.filter((r) => !r.archived);
}

const ALL = new Set(['KANBAN', 'IMPORT', 'REPORTS', 'SALES_SETTINGS', 'PURCHASES', 'BK_WIZARD']);

function menuOf(role: RoleConfig, opts: { isAdmin?: boolean; features?: ReadonlySet<string>; force?: ShellKind } = {}) {
  const viewer = testViewer({ userId: `u-${role.key}`, role, isAdmin: opts.isAdmin });
  return buildMenu({
    shell: opts.force ?? shellKindOf(role.menu),
    menu: role.menu,
    can: (p) => can(viewer, p),
    spaceReports: canSpaceReports(viewer),
    isAdmin: viewer.isAdmin,
    features: opts.features ?? ALL,
  });
}

const hrefs = (m: { items: readonly { href: string }[] }) => m.items.map((i) => i.href);

// Снимки пунктов (href) по ролям пресетов base и ЦРП; отдельно от тестов, чтобы правка меню была видна в диффе.
const SNAP = {
  lead: ['/summary', '/distribution', '/clients', '/bookings', '/deals', '/reports', '/settings', '/tasks', '/import'],
  manager: ['/call', '/clients', '/tasks', '/bookings'],
  observer: ['/director', '/clients', '/deals', '/reports', '/reports/exports'],
  operator: ['/call', '/clients', '/tasks', '/bookings', '/archive'],
  rop: ['/summary', '/distribution', '/clients', '/bookings', '/deals', '/reports', '/settings', '/tasks', '/import'],
  consultant: ['/consultations', '/tasks'],
  director: ['/director', '/clients', '/deals', '/reports', '/reports/exports'],
  marketing_head: ['/handoffs', '/clients', '/tasks'],
  marketer: ['/handoffs', '/clients', '/tasks'],
};

// Снимок: пресет base (Руководитель, Менеджер, Наблюдатель)
test('base: меню по ролям', () => {
  const snap = Object.fromEntries(rolesOf('base').map((r) => [r.key, { shell: menuOf(r).shell, items: hrefs(menuOf(r)), home: menuOf(r).home }]));
  assert.deepEqual(snap, {
    lead: { shell: 'manager', items: SNAP.lead, home: '/summary' },
    manager: { shell: 'operator', items: SNAP.manager, home: '/call' },
    observer: { shell: 'manager', items: SNAP.observer, home: '/director' },
  });
});

// Снимок: пресет ЦРП
test('crp: меню по ролям', () => {
  const snap = Object.fromEntries(rolesOf('clients/crp').map((r) => [r.key, { shell: menuOf(r).shell, items: hrefs(menuOf(r)), home: menuOf(r).home }]));
  assert.deepEqual(snap, {
    operator: { shell: 'operator', items: SNAP.operator, home: '/call' },
    rop: { shell: 'manager', items: SNAP.rop, home: '/summary' },
    consultant: { shell: 'consultant', items: SNAP.consultant, home: '/consultations' },
    director: { shell: 'manager', items: SNAP.director, home: '/director' },
    marketing_head: { shell: 'manager', items: SNAP.marketing_head, home: '/handoffs' },
    marketer: { shell: 'manager', items: SNAP.marketer, home: '/handoffs' },
  });
});

test('оператор: нижняя панель «Звонить / Клиенты / Задачи / Ещё» — три пункта до «Ещё»', () => {
  const op = rolesOf('clients/crp').find((r) => r.key === 'operator')!;
  const m = menuOf(op);
  assert.equal(m.bottomSlots, 3);
  assert.deepEqual(m.items.slice(0, 3).map((i) => i.id), ['call', 'clients', 'tasks']);
});

test('РОП: восемь основных пунктов в порядке ТЗ, остальные после них', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  const ids = menuOf(rop).items.map((i) => i.id);
  assert.deepEqual(ids.slice(0, 8), ['summary', 'distribution', 'clients', 'bookings', 'kanban', 'reports', 'settings', 'tasks']);
  assert.equal(menuOf(rop).bottomSlots, 4);
});

test('«Сотрудники» — только администратору, даже с ключом team в меню роли', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  assert.ok(!hrefs(menuOf(rop)).includes('/team'));
  assert.ok(hrefs(menuOf(rop, { isAdmin: true })).includes('/team'));
});

test('«Интеграции» — adminOnly и без флага WAZZUP: иначе карточка Beeline недоступна', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  const none = { features: new Set<string>() };
  assert.ok(hrefs(menuOf(rop, { ...none, isAdmin: true })).includes('/integrations'));
  assert.ok(!hrefs(menuOf(rop, { ...none })).includes('/integrations'));
});

test('администратор без роли: «Выгрузки», «Настройки», «Сотрудники» и «Интеграции», главная — «Сотрудники»', () => {
  const viewer = testViewer({ userId: 'u-admin', role: null, isAdmin: true });
  const m = buildMenu({ shell: shellKindOf([]), menu: [], can: (p) => can(viewer, p), spaceReports: canSpaceReports(viewer), isAdmin: true, features: ALL });
  assert.deepEqual(hrefs(m), ['/reports/exports', '/settings', '/team', '/integrations']); // «Выгрузки» и «Настройки» открыты администратору (orAdmin, R2b, M-1), «Интеграции» — adminOnly
  assert.equal(m.home, '/team', 'главная — не пункт orAdmin');
});

test('нет ни ролей, ни прав: пунктов нет, главная — личный кабинет', () => {
  const viewer = testViewer({ userId: 'u-none', role: null });
  const m = buildMenu({ shell: 'manager', menu: [], can: (p) => can(viewer, p), spaceReports: canSpaceReports(viewer), isAdmin: false });
  assert.deepEqual(m.items, []);
  assert.equal(m.home, '/account');
});

test('выключенный флаг скрывает модуль: Канбан без FEATURE_KANBAN', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  assert.ok(menuOf(rop).items.some((i) => i.id === 'kanban'));
  assert.ok(!menuOf(rop, { features: new Set() }).items.some((i) => i.id === 'kanban'));
});

test('выключенный флаг скрывает модуль: Импорт без FEATURE_IMPORT', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  assert.ok(menuOf(rop).items.some((i) => i.id === 'import'));
  assert.ok(!menuOf(rop, { features: new Set(['KANBAN']) }).items.some((i) => i.id === 'import'));
});

test('FEATURE_REPORTS выключен (D-295): нет «Панели директора»; «Отчёты» остаются только у права полной выгрузки', () => {
  const off = new Set(['KANBAN', 'IMPORT', 'SALES_SETTINGS']);
  const role = (k: string) => rolesOf('clients/crp').find((r) => r.key === k)!;
  const dir = hrefs(menuOf(role('director'), { features: off }));
  assert.ok(!dir.includes('/director'));
  // полная выгрузка — право клиента на свои данные (D-055): её кнопка живёт на /reports и флагом не прячется
  assert.ok(dir.includes('/reports') && dir.includes('/reports/exports'));
  assert.ok(hrefs(menuOf(role('rop'), { features: off })).includes('/reports'));
  // без права полной выгрузки пункта нет
  assert.ok(!hrefs(menuOf(role('marketing_head'), { features: off })).includes('/reports'));
  // охват `team` страница отчётов не пускает (404): пункта нет и при включённом флаге
  assert.ok(!hrefs(menuOf(role('marketing_head'))).includes('/reports'));
  // флаг включён — пункт «Отчёты» ровно один
  assert.equal(hrefs(menuOf(role('director'))).filter((h) => h === '/reports').length, 1);
});

test('FEATURE_SALES_SETTINGS выключен (D-295): «Настройки» скрыты и у РОП, и у администратора', () => {
  const off = new Set(['KANBAN', 'IMPORT', 'REPORTS']);
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  assert.ok(!hrefs(menuOf(rop, { features: off })).includes('/settings'));
  const admin = buildMenu({ shell: 'manager', menu: [], can: () => false, spaceReports: false, isAdmin: true, features: off });
  assert.ok(!hrefs(admin).includes('/settings'));
});

test('пункт скрыт, если роль его не включила в menu, даже при праве', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  const narrowed = { ...rop, menu: ['summary', 'distribution'] };
  assert.deepEqual(menuOf(narrowed).items.map((i) => i.id), ['summary', 'distribution', 'clients']);
});

test('пункт скрыт, если права нет, даже при ключе в menu', () => {
  const op = rolesOf('clients/crp').find((r) => r.key === 'operator')!;
  const noTasks = { ...op, grants: op.grants.filter((g) => g.perm !== 'task.read') };
  assert.ok(!menuOf(noTasks).items.some((i) => i.id === 'tasks'));
});

test('дежурный: оболочка duty показывает явку по отношению duty_today', () => {
  const op = rolesOf('clients/crp').find((r) => r.key === 'operator')!;
  const m = menuOf(op, { force: 'duty' });
  assert.equal(m.shell, 'duty');
  assert.deepEqual(m.items.map((i) => i.id), ['duty', 'bookings', 'clients']);
  const consultant = rolesOf('clients/crp').find((r) => r.key === 'consultant')!;
  // без отношения duty_today права booking.attend у консультанта есть через booked_with_me — явка видна
  assert.ok(menuOf(consultant, { force: 'duty' }).items.some((i) => i.id === 'duty'));
  const marketer = rolesOf('clients/crp').find((r) => r.key === 'marketer')!;
  assert.deepEqual(menuOf(marketer, { force: 'duty' }).items.map((i) => i.id), ['clients']);
});

test('isCurrentPath: точное совпадение и вложенные адреса, но не соседний раздел', () => {
  assert.ok(isCurrentPath('/clients', '/clients'));
  assert.ok(isCurrentPath('/clients/abc', '/clients'));
  assert.ok(!isCurrentPath('/clients-old', '/clients'));
  assert.ok(!isCurrentPath(null, '/clients'));
});

test('администратор без роли видит «Настройки» (orAdmin), оператор — нет (R2b)', () => {
  const noRole = (isAdmin: boolean) => buildMenu({ shell: 'manager', menu: [], can: () => false, spaceReports: false, isAdmin, features: ALL });
  assert.ok(hrefs(noRole(true)).includes('/settings'));
  assert.ok(!hrefs(noRole(false)).includes('/settings'));
});

test('директор видит «Панель директора» вместо «Сводки», РОП — наоборот', () => {
  const dir = rolesOf('clients/crp').find((r) => r.key === 'director')!;
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  assert.ok(hrefs(menuOf(dir)).includes('/director') && !hrefs(menuOf(dir)).includes('/summary'));
  assert.ok(hrefs(menuOf(rop)).includes('/summary') && !hrefs(menuOf(rop)).includes('/director'));
});

test('«Выгрузки»: директору (export.journal) и администратору; РОП без права — нет', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  assert.ok(!hrefs(menuOf(rop)).includes('/reports/exports'));
  const viewer = testViewer({ userId: 'u-admin', role: null, isAdmin: true });
  const m = buildMenu({ shell: shellKindOf([]), menu: [], can: (p) => can(viewer, p), spaceReports: canSpaceReports(viewer), isAdmin: true, features: ALL });
  assert.ok(hrefs(m).includes('/reports/exports'));
});

test('currentHref: из совпавших пунктов побеждает самый длинный href (/reports/exports)', () => {
  const hrefs = ['/reports', '/reports/exports', '/clients'];
  assert.equal(currentHref('/reports/exports', hrefs), '/reports/exports');
  assert.equal(currentHref('/reports', hrefs), '/reports');
  assert.equal(currentHref('/reports/x', hrefs), '/reports');
  assert.equal(currentHref('/other', hrefs), null);
  assert.equal(currentHref(null, hrefs), null);
});

// Страницы /handoffs и /consultations отвечают 404 без флага, значит и пункта меню без флага быть не должно
test('PURCHASES и BK_WIZARD выключены: «Передачи» и «Консультации» скрыты, а не ведут на 404', () => {
  const role = (k: string) => rolesOf('clients/crp').find((r) => r.key === k)!;
  const off = new Set(['KANBAN', 'IMPORT', 'REPORTS', 'SALES_SETTINGS']);
  assert.ok(hrefs(menuOf(role('marketing_head'))).includes('/handoffs'));
  assert.ok(!hrefs(menuOf(role('marketing_head'), { features: off })).includes('/handoffs'));
  assert.ok(hrefs(menuOf(role('consultant'))).includes('/consultations'));
  const c = menuOf(role('consultant'), { features: off });
  assert.ok(!hrefs(c).includes('/consultations'));
  assert.equal(c.home, '/tasks');
});

// D-319: группы бокового меню и название установки
test('группы меню: у каждого пункта каталога есть группа и подпись, группы не меняют пункты', async () => {
  const { MENU_GROUP, MENU_GROUPS } = await import('../../../src/ui/shells/menu');
  const shell = JSON.parse(readFileSync(join(ROOT, 'messages/ru/shell.json'), 'utf8')) as { nav: Record<string, string>; group: Record<string, string> };
  for (const id of Object.keys(shell.nav)) if (id !== 'label') assert.ok(MENU_GROUP[id as keyof typeof MENU_GROUP], `группа для ${id}`);
  for (const g of MENU_GROUPS) assert.ok(shell.group[g], `подпись группы ${g}`);
  assert.equal(shell.nav.kanban, 'Сделки', 'подпись пункта совпадает с заголовком его страницы');
});

test('оболочка берёт название из org.productName, а не из локали', () => {
  const src = readFileSync(join(ROOT, 'src/ui/shells/RoleShell.tsx'), 'utf8');
  assert.match(src, /org\.productName/);
  const shell = readFileSync(join(ROOT, 'src/ui/shells/AppShell.tsx'), 'utf8');
  assert.match(shell, /data-shell=\{variant\}/);
  assert.ok(!/px-4 py-4 md:px-8/.test(shell), 'оболочка не задаёт отступы страницы');
});
