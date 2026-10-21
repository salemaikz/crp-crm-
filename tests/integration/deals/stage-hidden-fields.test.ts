// Требования этапа и поля, скрытые роли (D-323): отказ не выдаёт ни ключ скрытого поля, ни то, заполнено ли оно.
// Если этап требует поле, скрытое роли зрителя, перенос для этой роли закрыт одинаково при пустом и заполненном
// поле — 409 `stage_restricted` без списка; видимые незаполненные поля по-прежнему перечисляются.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '@crm/core/config';
import { overrideDealsDepsForTests } from '../../../src/server/domain/deals/deps';
import { getDealsBoard } from '../../../src/server/domain/deals';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import { moveDealStage } from '../../../src/server/domain/deals/stage';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as stageRoute from '../../../src/app/api/deals/[id]/stage/route';
import { FX, THU_14, U, actAs, closeDealsWorld, dealsWorldConfig, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

const ORIGIN = 'http://crm.test';
let db: TestDb;
const clock = { now: THU_14 };
const deps = makeDealsDeps(clock);

before(async () => {
  db = await openDealsWorld();
  const rop = await viewerOf(U.rop);
  // Второе поле сделки `margin` скрыто роли РОП; этап `contract` требует оба поля
  const docs = dealsWorldConfig();
  const sp = docs.spaces.sales as Record<string, unknown>;
  const fieldsCfg = sp.fields as JsonObject[];
  fieldsCfg.push({ ...fieldsCfg[0]!, key: 'margin', label: { ru: 'Скрытое поле' }, access: { [rop.roleKey!]: 'hidden' } });
  const pipeline = (sp.pipelines as Array<{ stages: Array<{ key: string; requires: { fields: string[] } }> }>)[0]!;
  pipeline.stages.find((s) => s.key === 'contract')!.requires.fields = ['budget', 'margin'];
  resetConfigCache();
  await writeConfig({ docs, source: 'cli', authorId: null, project: true, note: 'сделки: поле, скрытое роли' });
  overrideDealsDepsForTests(deps);
});
after(async () => {
  overrideDealsDepsForTests(null);
  await closeDealsWorld(db);
});

const restricted = (e: unknown) => e instanceof DealDomainError && e.code === 'stage_restricted' && e.fields === undefined;

test('скрытое роли обязательное поле: отказ одинаков при пустом и заполненном поле, без ключей полей', async () => {
  const rop = await viewerOf(U.rop);
  await seedDeal(db.sql, { id: 'dl-h1', client: FX.bkInWindow.client, card: FX.bkInWindow.card, stage: 'offer' });
  const move = () => moveDealStage(deps, rop, { dealId: 'dl-h1', opId: uuid(), version: 0, stageKey: 'contract', nextStep: null });

  await assert.rejects(move(), restricted, 'оба поля пусты');
  await db.sql`UPDATE deals SET custom = '{"margin": "синтетика"}'::jsonb WHERE id = 'dl-h1'`;
  await assert.rejects(move(), restricted, 'скрытое заполнено, видимое пусто — тот же отказ');
  await db.sql`UPDATE deals SET custom = '{"budget": "синтетика"}'::jsonb WHERE id = 'dl-h1'`;
  await assert.rejects(move(), restricted, 'видимое заполнено, скрытое пусто — тот же отказ');
  await db.sql`UPDATE deals SET custom = '{"budget": "синтетика", "margin": "синтетика"}'::jsonb WHERE id = 'dl-h1'`;
  await assert.rejects(move(), restricted, 'оба заполнены — роль этап всё равно не ставит');
  assert.equal((await db.sql<{ stageKey: string }>`SELECT stage_key FROM deals WHERE id = 'dl-h1'`)[0]!.stageKey, 'offer');
});

test('маршрут: 409 stage_restricted без fields; роли, которой поле видно, — список видимых незаполненных', async () => {
  await seedDeal(db.sql, { id: 'dl-h2', client: FX.bkInWindow.client, card: FX.bkInWindow.card, stage: 'offer' });
  actAs(U.rop);
  const res = await stageRoute.POST(
    new Request(`${ORIGIN}/x`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ opId: uuid(), version: 0, stageKey: 'contract', nextStep: null }) }),
    { params: Promise.resolve({ id: 'dl-h2' }) },
  );
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 409);
  assert.deepEqual(body, { error: 'conflict', detail: 'stage_restricted' });
  assert.ok(!JSON.stringify(body).includes('margin'));

  // Роль консультанта поле видит: незаполненные перечисляются, как раньше
  const cons = await viewerOf(U.consultant);
  await assert.rejects(
    moveDealStage(deps, cons, { dealId: 'dl-h2', opId: uuid(), version: 0, stageKey: 'contract', nextStep: null }),
    (e: unknown) => e instanceof DealDomainError && e.code === 'stage_fields_required' && e.fields?.join() === 'budget,margin',
  );
});

test('доска: ни ключа, ни подписи скрытого поля; этапу с ним — «restricted» при пустом и заполненном поле', async () => {
  process.env.FEATURE_KANBAN = '1';
  try {
    const rop = await viewerOf(U.rop);
    await seedDeal(db.sql, { id: 'dl-h3', client: FX.bkInWindow.client, card: FX.bkInWindow.card, stage: 'offer' });
    const tileOf = async () => {
      const board = await getDealsBoard(rop);
      const json = JSON.stringify(board);
      assert.ok(!json.includes('margin') && !json.includes('Скрытое поле'), 'скрытое поле не уходит в доску');
      return board.columns.flatMap((c) => c.deals).find((d) => d.id === 'dl-h3')!;
    };
    assert.deepEqual((await tileOf()).missing['contract'], ['restricted']);
    await db.sql`UPDATE deals SET custom = '{"margin": "синтетика"}'::jsonb WHERE id = 'dl-h3'`;
    assert.deepEqual((await tileOf()).missing['contract'], ['restricted']);
  } finally {
    delete process.env.FEATURE_KANBAN;
  }
});
