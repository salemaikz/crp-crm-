// Изоляция меню оболочки (S2): у охвата карточек «свои» нет пункта доски РОП, страница /deals/calling ему не отдаёт данных.
// Отдельный файл зоны shell: файл board.test.ts принадлежит линии board.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../runner/hooks.mjs', import.meta.url);
process.env['FEATURE_REPORTS'] ??= '1';
process.env['FEATURE_SALES_SETTINGS'] ??= '1';
process.env['FEATURE_BK_WIZARD'] ??= '1';
process.env['FEATURE_PURCHASES'] ??= '1';
process.env['FEATURE_PUSH'] ??= '1';
process.env['FEATURE_OP_BOARD'] ??= '1';
process.env['FEATURE_KANBAN'] ??= '1';
process.env['FEATURE_CALLBACK_V2'] ??= '1';

const { createTestDb } = await import('../../../src/server/platform/db/testing');
const { resetAccessForTests } = await import('../../../src/server/access/testing');
const { actAs, enterSeedWorld, viewerOf } = await import('../harness/actors');
const { applySeedConfig } = await import('../harness/config');
const { U, seedIsolation } = await import('../harness/seed');
const { allForeignNeedles, markFixtures } = await import('../runner/objects');
const { leakViolations } = await import('../runner/checks');
const { invoke } = await import('../runner/invoke');
const { scanApp } = await import('../../helpers/appScan');
const { matchEntries } = await import('../../helpers/manifestCoverage');
const { allEntries } = await import('../harness/load');

import type { Needle } from '../runner/checks';
import type { TestDb } from '../../../src/server/platform/db/testing';

let db: TestDb;
let foreign: Needle[] = [];

before(async () => {
  db = await createTestDb();
  await seedIsolation(db.sql);
  await applySeedConfig();
  await markFixtures(db.sql);
  enterSeedWorld();
  foreign = await allForeignNeedles(db.sql);
});

after(async () => {
  resetAccessForTests();
  await db?.close();
});

describe('S2: пункт «Доска» менеджерской оболочки и страница /deals/calling только при охвате «пространство» и шире', () => {
  test('оператор (охват own): в меню менеджерской оболочки нет доски, страница не отдаёт данных; РОП и директор — доска есть (контроль)', async () => {
    const { loadMenu } = await import('../../../src/ui/shells/loadMenu');
    const hrefsOf = async (user: string) => {
      actAs(user);
      try {
        return (await loadMenu(await viewerOf(user), 'manager')).items.map((i) => i.href);
      } finally {
        actAs(null);
      }
    };
    assert.equal((await hrefsOf(U.opA)).includes('/deals/calling'), false, 'у оператора пункта доски РОП нет');
    for (const user of [U.rop, U.director]) assert.equal((await hrefsOf(user)).includes('/deals/calling'), true, `${user}: доска РОП есть`);

    const matched = matchEntries(scanApp('src'), await allEntries());
    const hit = [...matched].find(([, entry]) => entry.path === '/(mgr)/deals/calling');
    assert.ok(hit, '/(mgr)/deals/calling описан в манифесте');
    const page = await invoke(hit[0], hit[1], { userId: U.opA });
    assert.ok(page.status === 403 || page.status === 404, `оператор: /deals/calling → ${page.status}`);
    assert.deepEqual(leakViolations('оператор /deals/calling', page, foreign), []);
  });
});
