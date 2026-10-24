// Меню круга доработки (S2): «Мои покупки» оператору, «Доска» менеджерской оболочке, «Как работать» всем.
// Всё за флагом OP_BOARD; прежние пункты ролей не меняются (снимок без флага — tests/unit/ui/shells.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleConfig } from '@crm/core/access';
import { can, scopeOf } from '../../../src/server/access/viewer';
import { testViewer } from '../../../src/server/access/testing';
import { canSpaceReports } from '../../../src/server/domain/reports/access';
import { MENU_GROUP, buildMenu, shellKindOf, shellVariantOf, type ShellKind } from '../../../src/ui/shells/menu';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const BASE = ['KANBAN', 'IMPORT', 'REPORTS', 'SALES_SETTINGS', 'PURCHASES', 'BK_WIZARD'];

function rolesOf(preset: string): RoleConfig[] {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', preset, 'preset.json'), 'utf8')) as { global: { roles: RoleConfig[] } };
  return doc.global.roles.filter((r) => !r.archived);
}

function menuOf(role: RoleConfig, features: string[], force?: ShellKind) {
  const viewer = testViewer({ userId: `u-${role.key}`, role });
  const scope = scopeOf(viewer, 'card.read');
  return buildMenu({
    shell: force ?? shellKindOf(role.menu),
    menu: role.menu,
    can: (p) => can(viewer, p),
    spaceReports: canSpaceReports(viewer),
    wideCards: scope === 'space' || scope === 'all',
    isAdmin: viewer.isAdmin,
    features: new Set(features),
  });
}

const hrefs = (m: { items: readonly { href: string }[] }) => m.items.map((i) => i.href);

for (const preset of ['base', 'clients/crp']) {
  for (const role of rolesOf(preset)) {
    test(`${preset}/${role.key}: без OP_BOARD новых пунктов нет, прежние на месте`, () => {
      const m = menuOf(role, BASE);
      for (const h of ['/board/purchases', '/deals/calling', '/help']) assert.ok(!hrefs(m).includes(h), h);
    });

    test(`${preset}/${role.key}: с OP_BOARD — прежние пункты не меняются, добавляются только новые`, () => {
      const before = hrefs(menuOf(role, BASE));
      const withBoard = hrefs(menuOf(role, [...BASE, 'OP_BOARD']));
      const added = new Set(['/board', '/board/purchases', '/deals/calling', '/help']);
      const oldOnes = withBoard.filter((h) => !added.has(h));
      // «Клиенты» оператора заменяет поиск над доской (pipeline-v2 §9.1)
      assert.deepEqual(oldOnes, before.filter((h) => !(menuOf(role, BASE).shell === 'operator' && h === '/clients')));
      assert.ok(withBoard.includes('/help'), 'всем ролям — «Как работать»');
    });
  }
}

test('crp/operator: «Мои покупки» и «Как работать» после архива, на телефоне — в «Ещё»', () => {
  const op = rolesOf('clients/crp').find((r) => r.key === 'operator')!;
  const m = menuOf(op, [...BASE, 'OP_BOARD']);
  const list = hrefs(m);
  assert.deepEqual(list.slice(0, 3), ['/board', '/call', '/tasks']);
  assert.equal(m.bottomSlots, 3);
  assert.ok(list.indexOf('/board/purchases') >= 3, 'покупки не в нижней панели');
  assert.ok(list.includes('/board/purchases'));
  assert.equal(list.at(-1), '/help');
});

test('crp/rop: «Доска» в группе «Работа» сразу после панели директора или сводки, ведёт на /deals/calling', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  const list = hrefs(menuOf(rop, [...BASE, 'OP_BOARD']));
  const i = list.indexOf('/deals/calling');
  assert.ok(i > 0, 'пункт есть');
  assert.ok(list.indexOf('/summary') < i);
  assert.equal(MENU_GROUP.board, 'work');
  assert.ok(!list.includes('/board'), 'менеджерская оболочка ведёт не на /board');
});

test('«Доска» менеджерской оболочки — только при OP_BOARD (KANBAN не нужен, К5) и не при охвате ниже пространства', () => {
  const rop = rolesOf('clients/crp').find((r) => r.key === 'rop')!;
  const noKanban = BASE.filter((f) => f !== 'KANBAN');
  assert.ok(hrefs(menuOf(rop, [...noKanban, 'OP_BOARD'])).includes('/deals/calling'), 'без KANBAN доска РОП открыта — пункт есть');
  assert.ok(!hrefs(menuOf(rop, [...BASE])).includes('/deals/calling'), 'без OP_BOARD пункта нет');
  assert.ok(hrefs(menuOf(rop, [...BASE, 'OP_BOARD'])).includes('/deals/calling'));
  const viewer = testViewer({ userId: 'u-own', role: rop });
  const m = buildMenu({
    shell: 'manager',
    menu: rop.menu,
    can: (p) => can(viewer, p),
    spaceReports: true,
    wideCards: false, // охват own/team
    isAdmin: false,
    features: new Set([...BASE, 'OP_BOARD']),
  });
  assert.ok(!hrefs(m).includes('/deals/calling'), 'охват ниже пространства — пункта нет');
});

test('«Как работать» есть у консультанта и дежурного; подписи и группы в локали', () => {
  const consultant = rolesOf('clients/crp').find((r) => r.key === 'consultant')!;
  assert.ok(hrefs(menuOf(consultant, [...BASE, 'OP_BOARD'])).includes('/help'));
  const duty = menuOf(consultant, [...BASE, 'OP_BOARD'], 'duty');
  assert.ok(hrefs(duty).includes('/help'));
  const shell = JSON.parse(readFileSync(join(ROOT, 'messages/ru/shell.json'), 'utf8')) as { nav: Record<string, string> };
  assert.equal(shell.nav.purchases, 'Мои покупки');
  assert.equal(shell.nav.help, 'Как работать');
  assert.equal(MENU_GROUP.purchases, 'work');
  assert.equal(MENU_GROUP.help, 'work');
});

test('каждый пункт каталога имеет значок в ShellNav', () => {
  const nav = readFileSync(join(ROOT, 'src/ui/shells/ShellNav.tsx'), 'utf8');
  for (const id of Object.keys(MENU_GROUP)) assert.match(nav, new RegExp(`\\b${id}:\\s*[A-Z]`), `значок ${id}`);
});

test('вид каркаса оператора: side только при OP_BOARD, у остальных ролей всегда side', () => {
  assert.equal(shellVariantOf('operator', new Set()), 'bottom');
  assert.equal(shellVariantOf('operator', new Set(['OP_BOARD'])), 'side');
  for (const sh of ['manager', 'consultant', 'duty'] as const) assert.equal(shellVariantOf(sh, new Set()), 'side');
});

test('«Как работать» никогда не становится главной: без других пунктов главная — личный кабинет', () => {
  const m = buildMenu({ shell: 'manager', menu: [], can: () => false, spaceReports: false, isAdmin: false, features: new Set(['OP_BOARD']) });
  assert.deepEqual(m.items.map((i) => i.id), ['help']);
  assert.equal(m.home, '/account');
});
