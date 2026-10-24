// Вариант услуги в покупке (D-357, pv2-round3 §4): `variantKey` пишется в `deals.service_variant_key` и в `deal.won`,
// чужой/архивный/неизвестный вариант — 400 `variant_unknown`, повтор `requestId` — одна сделка, без варианта — ''.
// Сумма вариантом не проверяется (скидка). Плитка «Покупка» и «Мои покупки» несут ключи услуги и варианта.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../../src/server/access';
import { POST as purchasePost } from '../../../src/app/api/deals/purchase/route';
import { getBoard } from '../../../src/server/domain/cards/board';
import { listMine } from '../../../src/server/domain/deals/mine';
import { editPurchase, registerPurchase } from '../../../src/server/domain/deals/purchase';
import type { DealsDeps, PurchaseInput } from '../../../src/server/domain/deals/types';
import { getActiveConfig, resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { seedBookings, seedEvent } from '../booking/helpers';
import { actAs, FX, THU_14, U, closeDealsWorld, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: DealsDeps;
const clock = { now: THU_14 };
const C = FX.bkInWindow;
const ORIGIN = 'http://crm.test';

const label = (ru: string) => ({ ru });
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({ requestId: uuid(), cardId: C.card, dealId: null, serviceTypeKey: 'smm', amountKzt: 450_000, wonDay: '2026-10-29', ...over });
const rowOf = async (dealId: string) => (await db.sql<{ status: string; variant: string; amountKzt: number }>`SELECT status, service_variant_key AS variant, amount_kzt FROM deals WHERE id = ${dealId}`)[0]!;
const isBadVariant = (e: unknown) => e instanceof BadRequestError && e.detail === 'variant_unknown';

before(async () => {
  db = await openDealsWorld();
  deps = makeDealsDeps(clock);
  // Варианты услуг накладываются на мир сделок: у smm живой и архивный, у master_group свой
  const cfg = await getActiveConfig();
  const [key, space] = Object.entries(cfg.spaces).find(([, s]) => s.doc.serviceTypes !== undefined)!;
  const doc = space.doc as unknown as { serviceTypes: Array<Record<string, unknown>> };
  const serviceTypes = doc.serviceTypes.map((t) =>
    t['key'] === 'smm'
      ? { ...t, variants: [{ key: 'standard', label: label('Стандарт'), amountKzt: 450_000 }, { key: 'old_pack', label: label('Старый пакет'), amountKzt: 300_000, archived: true }] }
      : t['key'] === 'master_group'
        ? { ...t, variants: [{ key: 'solo', label: label('Один'), amountKzt: 90_000 }] }
        : t,
  );
  await writeConfig({ docs: { spaces: { [key]: { ...(doc as object), serviceTypes } as never } }, source: 'cli', authorId: null, note: 'варианты услуг' });
  resetConfigCache();
});
after(() => closeDealsWorld(db));

test('вариант пишется в сделку и в deal.won; сумма — как прислали (скидка)', async () => {
  await seedDeal(db.sql, { id: 'dl-var-1', client: C.client, card: C.card, stage: 'offer', owner: U.opB });
  const cons = await viewerOf(U.consultant);
  const req = input({ dealId: 'dl-var-1', variantKey: 'standard', amountKzt: 400_000 });
  const res = await registerPurchase(deps, cons, req);
  assert.equal(res.replayed, false);
  assert.deepEqual(await rowOf('dl-var-1'), { status: 'won', variant: 'standard', amountKzt: 400_000 });
  const feed = await db.sql<{ data: Record<string, unknown> }>`SELECT data FROM client_events WHERE id = ${req.requestId}`;
  assert.equal(feed[0]?.data['variantKey'], 'standard');
  assert.equal(feed[0]?.data['serviceTypeKey'], 'smm');
  const audit = await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'deal.purchase' AND entity_id = 'dl-var-1'`;
  assert.equal(audit[0]?.meta['variantKey'], 'standard');

});

test('чужой, архивный и неизвестный вариант — 400 variant_unknown, сделка не тронута', async () => {
  await seedDeal(db.sql, { id: 'dl-var-2', client: C.client, card: C.card, stage: 'offer', owner: U.opB });
  const cons = await viewerOf(U.consultant);
  for (const variantKey of ['solo', 'old_pack', 'nope']) {
    await assert.rejects(registerPurchase(deps, cons, input({ dealId: 'dl-var-2', variantKey })), isBadVariant, variantKey);
  }
  assert.deepEqual(await rowOf('dl-var-2'), { status: 'open', variant: '', amountKzt: 0 });
  // тип без вариантов: любой variantKey — отказ
  await assert.rejects(registerPurchase(deps, cons, input({ dealId: 'dl-var-2', serviceTypeKey: 'design', variantKey: 'standard' })), isBadVariant);
  // у типа master_group свой вариант проходит (контроль: отказ выше — не от общей поломки)
  await registerPurchase(deps, cons, input({ dealId: 'dl-var-2', serviceTypeKey: 'master_group', variantKey: 'solo', amountKzt: 90_000 }));
  assert.equal((await rowOf('dl-var-2')).variant, 'solo');
});

test('повтор requestId: одна сделка, вариант не меняется, второй deal.won не пишется', async () => {
  const cons = await viewerOf(U.consultant);
  const req = input({ variantKey: 'standard' });
  const first = await registerPurchase(deps, cons, req);
  const again = await registerPurchase(deps, cons, req);
  assert.equal(again.replayed, true);
  assert.equal(again.deal.id, first.deal.id);
  const n = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE request_id = ${req.requestId}`;
  assert.equal(n[0]!.n, 1);
  const e = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE id = ${req.requestId}`;
  assert.equal(e[0]!.n, 1);
  assert.equal((await rowOf(first.deal.id)).variant, 'standard');
});

test('без варианта в сделке пустая строка; deal.won ключа variantKey не несёт', async () => {
  const cons = await viewerOf(U.consultant);
  const req = input();
  const res = await registerPurchase(deps, cons, req);
  assert.equal((await rowOf(res.deal.id)).variant, '');
  const feed = await db.sql<{ data: Record<string, unknown> }>`SELECT data FROM client_events WHERE id = ${req.requestId}`;
  assert.equal('variantKey' in feed[0]!.data, false);
});

test('правка РОП: вариант проверяется по типу самой сделки; смена типа по-прежнему закрыта', async () => {
  const rop = await viewerOf(U.rop);
  const cons = await viewerOf(U.consultant);
  const res = await registerPurchase(deps, cons, input({ variantKey: 'standard' }));
  const version = (await db.sql<{ version: number }>`SELECT version FROM deals WHERE id = ${res.deal.id}`)[0]!.version;
  await assert.rejects(editPurchase(deps, rop, { dealId: res.deal.id, opId: uuid(), version, variantKey: 'solo' }), isBadVariant);
  assert.equal((await rowOf(res.deal.id)).variant, 'standard', 'вариант чужого типа не записан');
  const ok = await editPurchase(deps, rop, { dealId: res.deal.id, opId: uuid(), version, variantKey: 'standard', amountKzt: 420_000 });
  assert.equal(ok.amountKzt, 420_000);
  assert.deepEqual(await rowOf(res.deal.id), { status: 'won', variant: 'standard', amountKzt: 420_000 });
});

test('маршрут: плохой формат ключа — 400, неизвестный вариант — 400 variant_unknown, верный — 201', async () => {
  const post = async (body: Record<string, unknown>): Promise<Response> => {
    actAs(U.consultant);
    return purchasePost(new Request(`${ORIGIN}/api/deals/purchase`, { method: 'POST', headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
  };
  // Маршрут берёт настоящие часы: день покупки — «сейчас»
  const base = { cardId: C.card, dealId: null, serviceTypeKey: 'smm', amountKzt: 450_000, wonDay: null };
  assert.equal((await post({ ...base, requestId: uuid(), variantKey: 'Bad-Key' })).status, 400);
  const unknown = await post({ ...base, requestId: uuid(), variantKey: 'solo' });
  assert.equal(unknown.status, 400);
  assert.match(await unknown.text(), /variant_unknown/);
  const ok = await post({ ...base, requestId: uuid(), variantKey: 'standard' });
  assert.equal(ok.status, 201, await ok.clone().text());
});

test('плитка «Покупка» и «Мои покупки» несут ключи услуги и варианта (null — без варианта)', async () => {
  process.env['FEATURE_OP_BOARD'] = '1';
  try {
    const opA = await viewerOf(U.opA);
    await seedEvent(db.sql, { id: 'ev-var-mine', date: '2026-10-20', time: '15:00' });
    const wonDeal = async (n: number, variant: string): Promise<void> => {
      const card = `cd-a-${n}`;
      const client = `cl-a-${n}`;
      await db.sql`UPDATE cards SET state = 'client' WHERE id = ${card}`;
      await seedDeal(db.sql, { id: `dl-vm-${n}`, client, card, stage: 'paid', owner: U.opA, status: 'won' });
      await db.sql`UPDATE deals SET amount_kzt = 400000, service_type_key = 'smm', service_variant_key = ${variant}, won_at = ${THU_14 - n} WHERE id = ${`dl-vm-${n}`}`;
      const [bk] = await seedBookings(db.sql, 'ev-var-mine', [{ client, card }], { bookedBy: U.opA });
      await db.sql`UPDATE bookings SET deal_id = ${`dl-vm-${n}`} WHERE id = ${bk!}`;
    };
    await wonDeal(41, 'standard');
    await wonDeal(42, '');
    const board = await getBoard(opA, {});
    const tile = (id: string) => board.columns.flatMap((c) => c.cards).find((c) => c.id === id);
    assert.deepEqual([tile('cd-a-41')?.purchases?.lastServiceType, tile('cd-a-41')?.purchases?.lastVariant], ['smm', 'standard']);
    assert.deepEqual([tile('cd-a-42')?.purchases?.lastServiceType, tile('cd-a-42')?.purchases?.lastVariant], ['smm', null]);

    const mine = await listMine(deps, opA);
    const item = (id: string) => mine.items.find((i) => i.dealId === id)!;
    assert.deepEqual([item('dl-vm-41').serviceType, item('dl-vm-41').variant], ['smm', 'standard']);
    assert.deepEqual([item('dl-vm-42').serviceType, item('dl-vm-42').variant], ['smm', null]);
  } finally {
    delete process.env['FEATURE_OP_BOARD'];
  }
});
