// Утренняя сводка (PROCESS §11): оператору — перезвоны на сегодня и записи; РОП — просрочки и пул.
// Идемпотентно: `digest:<user>:<день>`; повтор слота ничего не создаёт. Пустая сводка оператору не нужна и не пишется.
import { randomUUID } from 'node:crypto';
import { time } from '@crm/core';
import type { SystemActor } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { notifyDeps } from './deps';
import {
  countBookingsOnDay,
  countCallbacksDue,
  countPool,
  insertNotifications,
  listRecipients,
  overdueCallbackStats,
  type NewNotification,
} from './repo';
import type { DigestReport, NotifyDeps, NotifyParams, RunInput } from './types';

export async function runDigest(_actor: SystemActor, input: RunInput, deps: NotifyDeps = notifyDeps()): Promise<DigestReport> {
  const cfg = await deps.config(input.spaceId);
  const day = input.calendar.localDay(input.now);
  // Конец местных суток: «перезвонов на сегодня» включает и просроченные, и те, что до вечера
  const dayEnd = time.fromLocalTime(time.addLocalDays(day, 1), '00:00', input.calendar.timezone);
  const db = await getDb();
  return db.tx(async (tx) => {
    const operators = await listRecipients(tx, { spaceId: cfg.spaceId, roles: cfg.operatorRoles });
    const managers = await listRecipients(tx, { spaceId: cfg.spaceId, roles: cfg.managerRoles });
    const rows: NewNotification[] = [];

    if (operators.length > 0) {
      const [callbacks, bookings] = await Promise.all([
        countCallbacksDue(tx, { spaceId: cfg.spaceId, userIds: operators, before: dayEnd }),
        countBookingsOnDay(tx, { spaceId: cfg.spaceId, userIds: operators, day }),
      ]);
      for (const userId of operators) {
        const params: NotifyParams['digest_operator'] = { callbacks: callbacks.get(userId) ?? 0, bookings: bookings.get(userId) ?? 0 };
        if (params.callbacks === 0 && params.bookings === 0) continue;
        rows.push({ id: randomUUID(), userId, kind: 'digest_operator', params, dedupeKey: `digest:${userId}:${day}` });
      }
    }

    if (managers.length > 0) {
      const [overdue, pool] = await Promise.all([
        overdueCallbackStats(tx, { spaceId: cfg.spaceId, olderThan: input.now }),
        countPool(tx, cfg.spaceId),
      ]);
      const params: NotifyParams['digest_manager'] = { overdue: overdue.count, pool };
      if (params.overdue > 0 || params.pool > 0) {
        for (const userId of managers) rows.push({ id: randomUUID(), userId, kind: 'digest_manager', params, dedupeKey: `digest:${userId}:${day}` });
      }
    }

    const created = await insertNotifications(tx, { rows, mode: 'ignore', now: input.now });
    return { operators: operators.length, managers: managers.length, created };
  });
}
