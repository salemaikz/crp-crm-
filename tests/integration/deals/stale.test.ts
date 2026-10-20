// «Сделка залежалась» (B4b, §3.5, D-244): счётчик для тревоги РОП. Порог ровно N дней, won/lost и этап без staleDays
// не считаются, чужое пространство не считается.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { countStaleDeals } from '../../../src/server/domain/deals/stale';
import type { DealPipelineInfo, DealStageInfo } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U } from '../../isolation/harness/seed';
import { DAY, SEED_NOW, closeWorld, openBookingWorld } from '../booking/helpers';

let db: TestDb;
const REQ = { fields: [], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false };
const stage = (key: string, kind: DealStageInfo['kind'], order: number, staleDays: number | null): DealStageInfo => ({
  key,
  label: { ru: key },
  kind,
  order,
  requires: REQ,
  staleDays,
  auto: null,
});
// Своя воронка: сидовые сделки мира в подсчёт не попадают
const PIPELINES: DealPipelineInfo[] = [
  { key: 'stale_p', label: { ru: 'p' }, createDealOn: 'manual', stages: [stage('s_a', 'open', 1, 14), stage('s_b', 'open', 2, 7), stage('s_free', 'open', 3, null), stage('s_won', 'won', 4, 3)] },
];

let n = 20;
async function deal(stageKey: string, status: 'open' | 'won' | 'lost', ageMs: number, space = SPACE): Promise<void> {
  const i = n++;
  await db.sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, won_at, lost_at, stage_changed_at, created_by, created_at, updated_at)
    VALUES (${`dl-st-${i}`}, ${space}, 'stale_p', ${stageKey}, ${status}, ${`cl-a-${i}`}, ${`cd-a-${i}`}, ${U.opA}, ${status === 'won' ? SEED_NOW - ageMs : null}, ${status === 'lost' ? SEED_NOW - ageMs : null}, ${SEED_NOW - ageMs}, ${U.opA}, ${SEED_NOW - 40 * DAY}, ${SEED_NOW - 40 * DAY})`;
}

before(async () => {
  db = await openBookingWorld();
});
after(() => closeWorld(db));

test('порог ровно N дней: 14 дней на s_a считается, на минуту меньше — нет', async () => {
  await deal('s_a', 'open', 14 * DAY);
  await deal('s_a', 'open', 14 * DAY - 60_000);
  assert.equal(await countStaleDeals({ spaceId: SPACE, now: SEED_NOW, pipelines: PIPELINES }), 1);
});

test('у каждого этапа свой срок; этап без staleDays и закрытые не считаются', async () => {
  await deal('s_b', 'open', 8 * DAY); // порог 7 — считается
  await deal('s_b', 'open', 6 * DAY); // нет
  await deal('s_free', 'open', 300 * DAY); // этап без staleDays
  await deal('s_won', 'won', 300 * DAY); // won
  await deal('s_a', 'lost', 300 * DAY); // lost на открытом этапе
  assert.equal(await countStaleDeals({ spaceId: SPACE, now: SEED_NOW, pipelines: PIPELINES }), 2);
});

test('другая воронка, не переданная в pipelines, и пустой список — 0', async () => {
  assert.equal(await countStaleDeals({ spaceId: SPACE, now: SEED_NOW, pipelines: [] }), 0);
  assert.equal(await countStaleDeals({ spaceId: SPACE, now: SEED_NOW, pipelines: [{ ...PIPELINES[0]!, key: 'other' }] }), 0);
});

test('другое пространство не считается', async () => {
  assert.equal(await countStaleDeals({ spaceId: 'sp-none', now: SEED_NOW, pipelines: PIPELINES }), 0);
});
