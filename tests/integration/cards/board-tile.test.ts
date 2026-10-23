// Плитка доски (U1): основной рабочий номер и ЛПР приходят вместе с карточкой. Цифры номера — только при охвате `own`
// (оператору на его карточках, как в очереди «Звонить»); РОП получает закрытый вид. Номер из стоп-листа плитке не отдаётся.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { getBoard } from '../../../src/server/domain/cards/board';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, addCard, clearOwner, closeBoardWorld, openBoardWorld } from './boardWorld';

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
