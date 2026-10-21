// Страж меню (D-313): каждый пункт меню ведёт на существующую страницу, право пункта не уже права страницы
// у ролей пресетов, а в roles[].menu нет мёртвых ключей. Дыра «пункт → 404» не должна вернуться.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Permission, RoleConfig } from '@crm/core/access';
import { can } from '../../../src/server/access/viewer';
import { testViewer } from '../../../src/server/access/testing';
import { buildMenu, MENU_KEYS, shellKindOf, type ShellKind } from '../../../src/ui/shells/menu';
import { allEntries } from '../../isolation/harness/load';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PRESETS = ['base', 'clients/crp'];
const SHELLS: ShellKind[] = ['operator', 'manager', 'consultant', 'duty'];
const FLAGS = ['KANBAN', 'IMPORT', 'REPORTS', 'SALES_SETTINGS', 'PURCHASES', 'BK_WIZARD', 'BULK_TRANSFER', 'WAZZUP'];
// ключи, которые выбирают оболочку, а не пункт каталога
const SHELL_KEYS = ['queue', 'consultations'];

function rolesOf(preset: string): RoleConfig[] {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', preset, 'preset.json'), 'utf8')) as { global: { roles: RoleConfig[] } };
  return doc.global.roles.filter((r) => !r.archived);
}

/** Адрес страницы без групп маршрутов: `/(mgr)/reports/exports` → `/reports/exports`. */
const urlOf = (path: string) => path.replace(/\/\([^/]+\)/g, '') || '/';

async function pagePerms(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of await allEntries()) if (e.kind === 'page') m.set(urlOf(e.path), e.perm);
  return m;
}

test('каждый пункт каталога ведёт на страницу из манифеста изоляции, и page.tsx существует', async () => {
  const pages = await pagePerms();
  const seen = new Set<string>();
  for (const shell of SHELLS) {
    const m = buildMenu({ shell, menu: [], can: () => true, isAdmin: true, features: new Set(FLAGS) });
    // пункты по ключам роли не включаются при пустом menu: добавляем все известные ключи
    const full = buildMenu({ shell, menu: [...MENU_KEYS], can: () => true, isAdmin: true, features: new Set(FLAGS) });
    for (const it of [...m.items, ...full.items]) seen.add(it.href);
  }
  assert.ok(seen.size > 10, 'каталог не пуст');
  for (const href of seen) {
    assert.ok(pages.has(href), `${href}: нет среди страниц манифеста изоляции`);
    const file = [`(op)`, `(mgr)`, `(consultant)`, `(duty)`, `(auth)`, ``]
      .map((g) => join(ROOT, 'src', 'app', g, href, 'page.tsx'))
      .find((f) => existsSync(f));
    assert.ok(file, `${href}: нет page.tsx в src/app`);
  }
});

for (const preset of PRESETS) {
  for (const role of rolesOf(preset)) {
    for (const [label, features] of [['все флаги', new Set(FLAGS)], ['без флагов', new Set<string>()]] as const) {
      test(`${preset}/${role.key} (${label}): право страницы проходит у каждого видимого пункта`, async () => {
        const pages = await pagePerms();
        const viewer = testViewer({ userId: `u-${role.key}`, role });
        for (const shell of [shellKindOf(role.menu)]) {
          const menu = buildMenu({ shell, menu: role.menu, can: (p) => can(viewer, p), isAdmin: false, features });
          for (const it of menu.items) {
            const perm = pages.get(it.href);
            assert.ok(perm, `${it.href}: страницы нет в манифесте`);
            if (perm === 'authenticated' || perm === 'public') continue;
            assert.ok(can(viewer, perm as Permission), `${role.key}: пункт ${it.href} виден, а право страницы ${perm} не проходит`);
          }
        }
      });
    }
  }
}

test('в roles[].menu пресетов нет мёртвых ключей', () => {
  const known = new Set([...MENU_KEYS, ...SHELL_KEYS]);
  for (const preset of PRESETS) {
    for (const role of rolesOf(preset)) {
      for (const key of role.menu) assert.ok(known.has(key), `${preset}/${role.key}: ключ меню «${key}» ничего не включает`);
    }
  }
});
