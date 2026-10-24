// Плитка доски (U1): основной рабочий номер и ЛПР приходят вместе с карточкой. Цифры номера — только при охвате `own`
// (оператору на его карточках, как в очереди «Звонить»); РОП получает закрытый вид. Номер из стоп-листа плитке не отдаётся.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { getBoard } from '../../../src/server/domain/cards/board';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import { testViewer } from '../../../src/server/access/testing';
import type { RoleConfig } from '@crm/core/access';
import { configDoc } from '../../isolation/harness/config';
import { SEED_TZ } from '../../isolation/harness/seed';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, addCard, clearOwner, closeBoardWorld, openBoardWorld } from './boardWorld';

let db: TestDb;
let opA: Viewer;
let rop: Viewer;

before(async () => {
  db = await openBoardWorld();
  opA = await viewerOf(U.opA);
  rop = await viewerOf(U.rop);
  await clearOwner(db.sql, U.opA);
  await addCard(db.sql, { id: 'tile-1', owner: U.opA, state: 'new', name: 'ТОО Синтетика Плитка 1' }, 501);
  await addCard(db.sql, { id: 'tile-2', owner: U.opA, state: 'new', name: 'ТОО Синтетика Плитка 2' }, 502);
  await db.sql`INSERT INTO contacts (id, client_id, name, position, is_decision_maker, created_at)
               VALUES ('ct-tile-1', 'cl-tile-1', 'Асель Синтетик', 'Директор', TRUE, ${SEED_NOW})`;
});
after(() => closeBoardWorld(db));

const tile = (b: Awaited<ReturnType<typeof getBoard>>, id: string) => b.columns.flatMap((c) => c.cards).find((c) => c.id === id);

test('оператор: на плитке закрытый номер, цифры для звонка и имя ЛПР', async () => {
  await enterSeedWorld();
  const t = tile(await getBoard(opA, {}), 'tile-1');
  assert.ok(t, 'плитка есть');
  assert.equal(t.lprName, 'Асель Синтетик');
  assert.equal(t.phone?.id, 'ph-tile-1');
  assert.equal(t.phone?.digits, '77098000501');
  assert.match(t.phone?.masked ?? '', /^\+7 709 ••• •• 01$/);
  assert.equal(tile(await getBoard(opA, {}), 'tile-2')?.lprName, '');
});

test('РОП (охват шире своих): номер только в закрытом виде, цифр в ответе нет', async () => {
  await enterSeedWorld();
  const b = await getBoard(rop, {});
  const t = tile(b, 'tile-1');
  assert.ok(t, 'плитка видна РОП');
  assert.match(t.phone?.masked ?? '', /••/);
  assert.equal(t.phone && 'digits' in t.phone, false);
  assert.ok(!JSON.stringify(b).includes('77098000501'), 'цифры номера не уходят РОП');
});

test('номер из стоп-листа плитке не отдаётся', async () => {
  await enterSeedWorld();
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77098000502')}, 'x', 'manual', ${SEED_NOW})`;
  const t = tile(await getBoard(opA, {}), 'tile-2');
  assert.equal(t?.phone, null);
});

test('вид номера плитки: мобильный и городской различаются, чтобы WhatsApp не предлагался на городской', async () => {
  await enterSeedWorld();
  await addCard(db.sql, { id: 'tile-3', owner: U.opA, state: 'new', name: 'ТОО Синтетика Плитка 3' }, 503);
  await db.sql`UPDATE client_phones SET kind = 'landline' WHERE id = 'ph-tile-3'`;
  const b = await getBoard(opA, {});
  assert.equal(tile(b, 'tile-1')?.phone?.kind, 'mobile');
  assert.equal(tile(b, 'tile-3')?.phone?.kind, 'landline');
  // РОП получает вид тоже: он не раскрывает номер
  assert.equal(tile(await getBoard(rop, {}), 'tile-3')?.phone?.kind, 'landline');
});

test('ownerName: у РОП (охват пространства) плитка несёт имя владельца, у оператора ключа нет вовсе', async () => {
  await enterSeedWorld();
  const [owner] = await db.sql<{ name: string }>`SELECT name FROM users WHERE id = ${U.opA}`;
  const ropTile = tile(await getBoard(rop, {}), 'tile-1');
  assert.equal(ropTile?.ownerName, owner!.name);
  const opTile = tile(await getBoard(opA, {}), 'tile-1');
  assert.ok(opTile, 'плитка оператора есть');
  assert.equal('ownerName' in opTile, false, 'у оператора ключа ownerName нет, а не пустая строка');
  assert.ok(!JSON.stringify(await getBoard(opA, {})).includes(owner!.name), 'и имя сотрудника в ответе оператора не встречается');
});

test('ownerName: карточка без владельца (пул) — пустое имя не выдумывается, ключа нет', async () => {
  await enterSeedWorld();
  await addCard(db.sql, { id: 'tile-4', owner: null, state: 'new', name: 'ТОО Синтетика Плитка 4' }, 504);
  const found = (await getBoard(rop, { q: 'Плитка 4' })).search?.matches.find((m) => m.id === 'tile-4');
  assert.ok(found);
  assert.equal('ownerName' in found, false);
});

test('«Покупка»: плитка несёт сумму последней покупки в целых тенге; у карточки не-клиента суммы нет', async () => {
  await enterSeedWorld();
  await addCard(db.sql, { id: 'tile-5', owner: U.opA, state: 'client', name: 'ТОО Синтетика Плитка 5', purchasesTotal: 2, lastPurchaseAt: SEED_NOW - 1000 }, 505);
  for (const [id, amount, wonAt] of [['dl-tile-5a', 90000, SEED_NOW - 5000], ['dl-tile-5b', 150000, SEED_NOW - 1000]] as const) {
    await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, stage_changed_at, created_at, updated_at)
                 VALUES (${id}, ${SPACE}, 'sales', 'won', 'won', 'cl-tile-5', 'tile-5', ${U.opA}, 'smm', ${amount}, ${wonAt}, ${wonAt}, ${wonAt}, ${wonAt})`;
  }
  const b = await getBoard(opA, {});
  assert.deepEqual(tile(b, 'tile-5')?.purchases, { total: 2, lastAt: SEED_NOW - 1000, lastAmountKzt: 150000, lastServiceType: 'smm', lastVariant: null });
  assert.equal(tile(b, 'tile-1')?.purchases?.lastAmountKzt, null, 'у «Новой» карточки суммы нет');
});

test('«Покупка»: дата берётся у той же сделки, что и сумма, даже если кэш карточки не пересчитан', async () => {
  await enterSeedWorld();
  await addCard(db.sql, { id: 'tile-6', owner: U.opA, state: 'client', name: 'ТОО Синтетика Плитка 6', purchasesTotal: 0 }, 506);
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, stage_changed_at, created_at, updated_at)
               VALUES ('dl-tile-6', ${SPACE}, 'sales', 'won', 'won', 'cl-tile-6', 'tile-6', ${U.opA}, 'smm', 90000, ${SEED_NOW - 2000}, ${SEED_NOW - 2000}, ${SEED_NOW - 2000}, ${SEED_NOW - 2000})`;
  const b = await getBoard(opA, {});
  assert.deepEqual(tile(b, 'tile-6')?.purchases, { total: 0, lastAt: SEED_NOW - 2000, lastAmountKzt: 90000, lastServiceType: 'smm', lastVariant: null });
});

test('«Покупка»: сумма читается под охватом deal.read; роль с card.read=space и deal.read=own чужих сумм не видит', async () => {
  await enterSeedWorld();
  const ropRole = (configDoc() as { global: { roles: RoleConfig[] } }).global.roles.find((r) => r.key === 'rop')!;
  // Охват card.read — пространство, deal.read задаётся: так выглядит роль, заданная через CLI (D-300)
  const as = (dealScope: 'own' | 'space'): Viewer => {
    const grants = ropRole.grants.map((g) => (g.perm === 'deal.read' ? { ...g, scope: dealScope } : g.perm === 'card.read' ? { ...g, scope: 'space' as const } : g));
    return testViewer({ userId: U.rop, role: { ...ropRole, grants }, spaceId: SPACE, now: SEED_NOW, timeZone: SEED_TZ });
  };
  const b = await getBoard(as('own'), {});
  const t = tile(b, 'tile-5');
  assert.ok(t, 'карточка видна по card.read');
  assert.equal(t.purchases?.lastAmountKzt, null, 'сумма чужой сделки не отдаётся');
  assert.ok(!JSON.stringify(b).includes('150000'), 'суммы нет нигде в ответе');
  // Контроль: с охватом пространства по deal.read та же сумма на месте
  assert.equal(tile(await getBoard(as('space'), {}), 'tile-5')?.purchases?.lastAmountKzt, 150000);
});
