// Общая подготовка интеграционных тестов раздачи: мир изоляции (операторы A, B и «Дежурный» — три участника, РОП,
// директор), пул без владельца, настройки и часы. Только синтетика (+7 709 …).
import { distribution, time } from '../../../packages/core/src';
import { systemActor } from '../../../src/server/access/systemActor';
import type { DistributionConfig, DistributionDeps } from '../../../src/server/domain/distribution/types';
import type { Sql } from '../../../src/server/platform/db';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SEED_TODAY, SEED_TZ, SPACE, U } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from '../access/world';

export { SEED_NOW, SEED_TODAY, SEED_TZ, SPACE, U };
export { viewerOf, actAs } from '../../isolation/harness/actors';
export { closeWorld };

export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;
/** Три участника раздачи из синтетики изоляции (роль operator, в раздаче). */
export const OPERATORS = [U.opA, U.opB, U.duty] as const;

export const calendar = time.createWorkCalendar({
  timezone: SEED_TZ,
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  // 26.10.2026 — перенос выходного (День Республики 25.10 выпал на воскресенье)
  holidays: [{ date: '2026-10-26', kind: 'holiday' }],
});

export function testConfig(over: Partial<distribution.DistributionSettings> = {}, extra: Partial<DistributionConfig> = {}): DistributionConfig {
  return {
    spaceId: SPACE,
    timeZone: SEED_TZ,
    settings: {
      mode: 'auto_even',
      schedule: { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true },
      dailyCap: 40,
      capIncludes: ['auto', 'manual', 'return'],
      capOverride: false,
      topUpKeep: 10,
      ...over,
    },
    participantRoles: ['operator'],
    mobileFirst: true,
    calendar: distribution.toDistributionCalendar(calendar),
    ...extra,
  };
}

export interface Clock {
  now: number;
}

export function makeDeps(clock: Clock, cfg: DistributionConfig = testConfig()): DistributionDeps {
  return { config: async () => cfg, now: () => clock.now };
}

export const uuid = (): string => globalThis.crypto.randomUUID();

export function tickInput(clock: Clock, runId: string = uuid(), slotAt: number = clock.now) {
  return { spaceId: SPACE, runId, slotAt, now: clock.now };
}

export const system = (now: number = SEED_NOW) => systemActor('distribute:sales', now);

export async function openDistributionWorld(): Promise<TestDb> {
  return openWorld();
}

export const poolCardId = (i: number) => `pc-${i}`;
export const poolClientId = (i: number) => `pl-${i}`;

/** Пул: n новых карточек без владельца, у каждой мобильный номер; порядок поступления = номер. */
export async function seedPool(sql: Sql, n: number, o: { from?: number; mobile?: boolean } = {}): Promise<string[]> {
  const from = o.from ?? 1;
  const t = SEED_NOW - DAY;
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) ids.push(poolCardId(i));
  const nums = Array.from({ length: n }, (_, k) => from + k);
  await sql`
    INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
    SELECT 'pl-' || i, 'company', 'ТОО Пул ' || i, 'пул ' || i, 'пул ' || i, 'import', ${t}::bigint, ${t}::bigint
      FROM unnest(${nums}::int[]) AS i`;
  await sql`
    INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
    SELECT 'pp-' || i, 'pl-' || i, '77092' || lpad(i::text, 6, '0'), ${o.mobile === false ? 'landline' : 'mobile'}::text, TRUE, ${t}::bigint
      FROM unnest(${nums}::int[]) AS i`;
  await sql`
    INSERT INTO cards (id, space_id, client_id, owner_user_id, state, created_at, updated_at)
    SELECT 'pc-' || i, ${SPACE}::text, 'pl-' || i, NULL, 'new', ${t}::bigint + i * 1000, ${t}::bigint + i * 1000
      FROM unnest(${nums}::int[]) AS i`;
  return ids;
}

/** Пара клиентов пула как «двойники» (общий номер). */
export async function seedPair(sql: Sql, a: string, b: string, status: 'open' | 'distinct' | 'split_allowed' | 'merged' = 'open'): Promise<void> {
  const [x, y] = a < b ? [a, b] : [b, a];
  await sql`
    INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, created_at)
    VALUES (${`dp-${x}-${y}`}, ${x}, ${y}, 'shared_phone', ${status}, ${SEED_NOW - DAY})`;
}

export async function ownersOf(sql: Sql, ids: readonly string[]): Promise<Record<string, string | null>> {
  const rows = await sql<{ id: string; ownerUserId: string | null }>`SELECT id, owner_user_id FROM cards WHERE id = ANY(${[...ids]}::text[])`;
  return Object.fromEntries(rows.map((r) => [r.id, r.ownerUserId]));
}

/** Сколько карточек пула (pc-*) у каждого владельца; ключ '' — в пуле. */
export async function poolOwnership(sql: Sql): Promise<Record<string, number>> {
  const rows = await sql<{ owner: string; n: number }>`
    SELECT COALESCE(owner_user_id, '') AS owner, count(*)::int AS n FROM cards WHERE id LIKE 'pc-%' GROUP BY 1`;
  return Object.fromEntries(rows.map((r) => [r.owner, r.n]));
}

export async function logCount(sql: Sql, kind?: string): Promise<number> {
  const rows = kind
    ? await sql<{ n: number }>`SELECT count(*)::int AS n FROM assign_log WHERE kind = ${kind}`
    : await sql<{ n: number }>`SELECT count(*)::int AS n FROM assign_log`;
  return rows[0]?.n ?? 0;
}

export async function eventCount(sql: Sql): Promise<number> {
  return (await sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'card.assigned'`)[0]?.n ?? 0;
}

export async function noteCount(sql: Sql): Promise<number> {
  return (await sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE kind = 'cards_assigned'`)[0]?.n ?? 0;
}

/** Выдачи, записанные раньше сегодня: расход лимита оператора (синтетические строки журнала). */
export async function seedIssued(sql: Sql, userId: string, kind: 'manual' | 'return' | 'auto' | 'release', n: number, cards: readonly string[], countsToCap = true): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
      VALUES (${`al-${kind}-${userId}-${i}`}, ${SPACE}, ${cards[i % cards.length] as string}, NULL, ${userId}, ${kind}, ${countsToCap}, ${`seed-${kind}`}, ${SEED_TODAY}, NULL, ${SEED_NOW - 3 * 60 * MIN})`;
  }
}

/** Сброс выдач между прогонами одного теста: карточки пула обратно в пул, журнал и уведомления очищены. */
export async function resetPool(sql: Sql): Promise<void> {
  await sql`UPDATE cards SET owner_user_id = NULL, assigned_at = NULL, version = 0 WHERE id LIKE 'pc-%'`;
  await sql`DELETE FROM assign_log`;
  await sql`DELETE FROM client_events WHERE kind = 'card.assigned'`;
  await sql`DELETE FROM notifications WHERE kind = 'cards_assigned'`;
}
