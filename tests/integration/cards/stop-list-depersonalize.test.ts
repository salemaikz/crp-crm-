// Строка стоп-листа, поставленная обезличиванием (`source = 'depersonalize'`), не снимается никем (D-321): субъект
// попросил забыть его и не звонить, «Снять «Не звонить»» у карточки с тем же номером её не трогает.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearDnc } from '../../../src/server/domain/cards';
import { removeFromStopList } from '../../../src/server/domain/cards/repo';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { SEED_NOW, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, setCard, uuid, viewerOf } from '../calls/world';

let db: TestDb;
before(async () => {
  db = await openCallsWorld();
});
after(() => closeCallsWorld(db));

const stopRow = async (digits: string) =>
  (await db.sql<{ source: string }>`SELECT source FROM stop_list WHERE phone_hmac = ${phoneHmac(digits)}`).map((r) => r.source);

async function putStop(digits: string, source: 'depersonalize' | 'outcome'): Promise<void> {
  await db.sql`
    INSERT INTO stop_list (phone_hmac, reason_code, source, created_by, created_at)
    VALUES (${phoneHmac(digits)}, 'asked', ${source}, NULL, ${SEED_NOW})
    ON CONFLICT (phone_hmac) DO UPDATE SET source = EXCLUDED.source`;
}

test('«Снять «Не звонить»»: номер обезличивания остаётся в стоп-листе, обычный снимается; в аудите снят один', async () => {
  const i = 59;
  await setCard(db.sql, cardOf('a', i), { state: 'do_not_call', owner: U.opA });
  // Второй номер клиента — синтетика +7 709, чтобы у карточки было два номера в стоп-листе
  await db.sql`
    INSERT INTO client_phones (id, client_id, digits, kind, is_working, is_primary, created_at)
    VALUES (${uuid()}, ${clientOf('a', i)}, '77090005901', 'mobile', TRUE, FALSE, ${SEED_NOW})`;
  const phones = await db.sql<{ digits: string }>`SELECT digits FROM client_phones WHERE client_id = ${clientOf('a', i)} AND is_working ORDER BY digits`;
  assert.ok(phones.length >= 2);
  const [dep, plain] = [phones[0]!.digits, phones[1]!.digits];
  await putStop(dep, 'depersonalize');
  await putStop(plain, 'outcome');

  const rop = await viewerOf(U.rop);
  const v = (await db.sql<{ version: number }>`SELECT version FROM cards WHERE id = ${cardOf('a', i)}`)[0]!.version;
  const res = await clearDnc(rop, cardOf('a', i), { opId: uuid(), version: v, comment: 'Клиент сам попросил перезвонить' });
  assert.equal(res.state, 'callback');
  assert.deepEqual(await stopRow(dep), ['depersonalize'], 'строка обезличивания не снимается');
  assert.deepEqual(await stopRow(plain), [], 'обычная строка снята');
  const audit = await db.sql<{ meta: { phonesRemoved: number } }>`
    SELECT meta FROM audit_log WHERE action = 'card.dnc_cleared' AND entity_id = ${cardOf('a', i)}`;
  assert.deepEqual(audit.map((a) => a.meta.phonesRemoved), [1]);
});

test('репозиторий: удаление номера из стоп-листа не трогает строку обезличивания', async () => {
  const dep = '77090005902';
  const plain = '77090005903';
  await putStop(dep, 'depersonalize');
  await putStop(plain, 'outcome');
  await db.tx(async (tx) => {
    await removeFromStopList(tx, dep);
    await removeFromStopList(tx, plain);
  });
  assert.deepEqual(await stopRow(dep), ['depersonalize']);
  assert.deepEqual(await stopRow(plain), []);
});
