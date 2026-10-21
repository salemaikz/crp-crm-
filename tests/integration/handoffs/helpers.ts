// Мир тестов входящих передач (B6b): мир сделок + покупка «с передачей» и второй отдел со своим руководителем.
import { registerPurchase } from '../../../src/server/domain/deals/purchase';
import { overrideDealsDepsForTests } from '../../../src/server/domain/deals/deps';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { THU_14, U, closeDealsWorld, makeDealsDeps, openDealsWorld, uuid, viewerOf } from '../deals/helpers';

export { THU_14, FRI_18, U, FX, SPACE, TEAM_MKT, DAY, actAs, uuid, viewerOf } from '../deals/helpers';

export const clock = { now: THU_14 };
export const OTHER_HEAD = 'u-design-head';
export let teamDesign = '';

export async function openHandoffsWorld(): Promise<TestDb> {
  const db = await openDealsWorld();
  overrideDealsDepsForTests(makeDealsDeps(clock));
  const t = THU_14 - 86_400_000;
  await db.sql`INSERT INTO users (id, phone_digits, name, is_admin, status, created_at) VALUES (${OTHER_HEAD}, '77099009001', 'Руководитель Синтетик Б', FALSE, 'active', ${t})`;
  // отдел «design» уже есть в проекции настроек: ему нужен свой руководитель
  const team = await db.sql<{ id: string }>`UPDATE teams SET lead_user_id = ${OTHER_HEAD}, archived_at = NULL WHERE space_id = 'sp-sales' AND key = 'design' RETURNING id`;
  teamDesign = team[0]!.id;
  await db.sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at) VALUES (${OTHER_HEAD}, 'sp-sales', 'marketing_head', ${teamDesign}, FALSE, ${t}, ${t})`;
  return db;
}

export async function closeHandoffsWorld(db: TestDb): Promise<void> {
  overrideDealsDepsForTests(null);
  await closeDealsWorld(db);
}

/** Покупка услуги отдела по карточке оператора B №n: передача `pending`, задача главе отдела. */
export async function buy(n: number, serviceTypeKey = 'smm'): Promise<{ handoffId: string; dealId: string }> {
  const rop: Viewer = await viewerOf(U.rop);
  const r = await registerPurchase(makeDealsDeps(clock), rop, { requestId: uuid(), cardId: `cd-b-${n}`, dealId: null, serviceTypeKey, amountKzt: 450_000, wonDay: null });
  if (!r.handoffId) throw new Error('передача не создана');
  return { handoffId: r.handoffId, dealId: r.deal.id };
}
