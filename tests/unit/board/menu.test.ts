// Меню оператора при флаге OP_BOARD (pipeline-v2 §9.1): «Доска · Звонить · Задачи · Ещё», «Клиенты» скрыты.
// Без флага меню прежнее.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Permission } from '@crm/core/access';
import { buildMenu } from '@/ui/shells/menu';

const PERMS = new Set<Permission>(['card.read', 'card.outcome', 'client.read', 'task.read', 'booking.read']);
const MENU = ['queue', 'tasks', 'bookings', 'archive'];

const build = (features: string[]) =>
  buildMenu({ shell: 'operator', menu: MENU, can: (p) => PERMS.has(p), spaceReports: false, isAdmin: false, features: new Set(features) });

test('с OP_BOARD: Доска первая и главная, Клиентов нет, Звонить и Задачи на месте', () => {
  const m = build(['OP_BOARD']);
  const hrefs = m.items.map((i) => i.href);
  assert.deepEqual(hrefs.slice(0, 3), ['/board', '/call', '/tasks']);
  assert.ok(!hrefs.includes('/clients'));
  assert.equal(m.home, '/board');
  assert.equal(m.bottomSlots, 3);
});

test('без OP_BOARD: меню прежнее — доски нет, Клиенты есть, главная — «Звонить»', () => {
  const m = build([]);
  const hrefs = m.items.map((i) => i.href);
  assert.ok(!hrefs.includes('/board'));
  assert.deepEqual(hrefs.slice(0, 3), ['/call', '/clients', '/tasks']);
  assert.equal(m.home, '/call');
});

test('доска не показывается без права `card.outcome` (директор, консультант)', () => {
  const m = buildMenu({ shell: 'operator', menu: MENU, can: (p) => p !== 'card.outcome' && PERMS.has(p), spaceReports: false, isAdmin: false, features: new Set(['OP_BOARD']) });
  assert.ok(!m.items.some((i) => i.href === '/board'));
});

test('пункт «Доска» входит в группу «Работа» и имеет подпись в локали', async () => {
  const { MENU_GROUP } = await import('@/ui/shells/menu');
  assert.equal(MENU_GROUP.board, 'work');
  const shell = (await import('../../../messages/ru/shell.json', { with: { type: 'json' } })).default as { nav: Record<string, string> };
  assert.equal(shell.nav.board, 'Доска');
});
