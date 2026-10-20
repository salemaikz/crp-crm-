// Подготовка интеграционных тестов уведомлений: мир изоляции (операторы A, B, дежурный-оператор, РОП), часы и настройки.
// Только синтетика (+7 709 …).
import { overrideNotifyDepsForTests } from '../../../src/server/domain/notify/deps';
import type { NotifyConfig } from '../../../src/server/domain/notify/types';
import type { Sql } from '../../../src/server/platform/db';
import { SEED_NOW, SEED_TODAY, SPACE, U } from '../../isolation/harness/seed';
import { calendar, closeWorld, openDistributionWorld, seedPool, system } from '../distribution/helpers';

export { SEED_NOW, SEED_TODAY, SPACE, U, calendar, closeWorld, seedPool, system };
export const openWorld = openDistributionWorld;

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const config = (over: Partial<NotifyConfig> = {}): NotifyConfig => ({
  spaceId: SPACE,
  managerRoles: ['rop'],
  operatorRoles: ['operator'],
  morningDigestAt: '09:00',
  overdueAlertMinutes: 60,
  ...over,
});

export function useConfig(cfg: NotifyConfig = config()): void {
  overrideNotifyDepsForTests({ config: async () => cfg });
}

export const runInput = (now: number = SEED_NOW) => ({ spaceId: SPACE, now, calendar });

/** Перевести карточку в «Перезвонить» со сроком. */
export async function setCallback(sql: Sql, cardId: string, nextCallAt: number): Promise<void> {
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${nextCallAt}::bigint WHERE id = ${cardId}`;
}

export async function notificationsOf(sql: Sql, userId: string): Promise<Array<{ kind: string; params: Record<string, number>; readAt: number | null; dedupeKey: string | null }>> {
  return sql`SELECT kind, params, read_at, dedupe_key FROM notifications WHERE user_id = ${userId} ORDER BY kind, created_at`;
}

export async function countAll(sql: Sql): Promise<number> {
  const [row] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications`;
  return row?.n ?? 0;
}

/** «Серая» БК: индивидуальная запись без консультанта. */
export async function seedGrey(sql: Sql, a: { id: string; cardId: string; clientId: string; day: string; startsAt: number; createdAt: number; responsible: string }): Promise<void> {
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time,
                                  starts_at, duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
            VALUES (${a.id}, ${SPACE}, 'individual', 'consult', NULL, ${a.clientId}, ${a.cardId}, ${a.day}, '15:00',
                    ${a.startsAt}::bigint, 60, ${a.responsible}, ${a.responsible}, ${a.createdAt}::bigint, ${a.createdAt}::bigint)`;
}
