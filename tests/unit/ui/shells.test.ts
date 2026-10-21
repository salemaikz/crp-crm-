// Оболочки по ролям (P9b): меню каждой роли пресетов base и crp, скрытие по правам, флагам и администратору.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleConfig } from '@crm/core/access';
import { can } from '../../../src/server/access/viewer';
import { testViewer } from '../../../src/server/access/testing';
import { buildMenu, isCurrentPath, shellKindOf, type ShellKind } from '../../../src/ui/shells/menu';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function rolesOf(preset: string): RoleConfig[] {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', preset, 'preset.json'), 'utf8')) as { global: { roles: RoleConfig[] } };
  return doc.global.roles.filter((r) => !r.archived);
}

const ALL = new Set(['KANBAN', 'IMPORT']);

function menuOf(role: RoleConfig, opts: { isAdmin?: boolean; features?: ReadonlySet<string>; force?: ShellKind } = {}) {
  const viewer = testViewer({ userId: `u-${role.key}`, role, isAdmin: opts.isAdmin });
  return buildMenu({
    shell: opts.force ?? shellKindOf(role.menu),
    menu: role.menu,
    can: (p) => can(viewer, p),
    isAdmin: viewer.isAdmin,
    features: opts.features ?? ALL,
  });
}

const hrefs = (m: { items: readonly { href: string }[] }) => m.items.map((i) => i.href);

// Снимки пунктов (href) по ролям пресетов base и ЦРП; отдельно от тестов, чтобы правка меню была видна в диффе.
const SNAP = {
  lead: ['/summary', '/distribution', '/cards', '/clients', '/bookings', '/deals', '/reports', '/settings', '/pool', '/tasks', '/import'],
  manager: ['/call', '/clients', '/tasks', '/bookings', '/my-day'],
  observer: ['/summary', '/cards', '/clients', '/deals', '/reports'],
  operator: ['/call', '/clients', '/tasks', '/bookings', '/archive', '/my-day'],
  rop: ['/summary', '/distribution', '/cards', '/clients', '/bookings', '/deals', '/reports', '/settings', '/pool', '/tasks', '/import'],
  consultant: ['/consultations', '/tasks', '/my-day'],
  director: ['/summary', '/cards', '/clients', '/deals', '/reports'],
  marketing_head: ['/handoffs', '/clients', '/reports', '/tasks'],
  marketer: ['/handoffs', '/clients', '/tasks'],
};

// Снимок: пресет base (Руководитель, Менеджер, Наблюдатель)
test('base: меню по ролям', () => {
  const snap = Object.fromEntries(rolesOf('base').map((r) => [r.key, { shell: menuOf(r).shell, items: hrefs(menuOf(r)), home: menuOf(r).home }]));
  assert.deepEqual(snap, {
    lead: { shell: 'manager', items: SNAP.lead, home: '/summary' },
    manager: { shell: 'operator', items: SNAP.manager, home: '/call' },
    observer: { shell: 'manager', items: SNAP.observer, home: '/summary' },
  });
});

// Снимок: пресет ЦРП
test('crp: меню по ролям', () => {
  const snap = Object.fromEntries(rolesOf('clients/crp').map((r) => [r.key, { shell: menuOf(r).shell, items: hrefs(menuOf(r)), home: menuOf(r).home }]));
  assert.deepEqual(snap, {
    operator: { shell: 'operator', items: SNAP.operator, home: '/call' },
    rop: { shell: 'manager', items: SNAP.rop, home: '/summary' },
    consultant: { shell: 'consultant', items: SNAP.consultant, home: '/consultations' },
    director: { shell: 'manager', items: SNAP.director, home: '/summary' },
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
  assert.deepEqual(ids.slice(0, 8), ['summary', 'distribution', 'cards', 'clients', 'bookings', 'kanban', 'reports', 'settings']);
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

test('администратор без роли: «Сотрудники» и «Интеграции», главная — «Сотрудники»', () => {
  const viewer = testViewer({ userId: 'u-admin', role: null, isAdmin: true });
  const m = buildMenu({ shell: shellKindOf([]), menu: [], can: (p) => can(viewer, p), isAdmin: true, features: ALL });
  assert.deepEqual(hrefs(m), ['/team', '/integrations']);
  assert.equal(m.home, '/team');
});

test('нет ни ролей, ни прав: пунктов нет, главная — личный кабинет', () => {
  const viewer = testViewer({ userId: 'u-none', role: null });
  const m = buildMenu({ shell: 'manager', menu: [], can: (p) => can(viewer, p), isAdmin: false });
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

test('пункт скрыт, если роль его не включила в menu, даже при праве', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  const narrowed = { ...rop, menu: ['summary', 'cards'] };
  assert.deepEqual(menuOf(narrowed).items.map((i) => i.id), ['summary', 'cards', 'clients']);
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
