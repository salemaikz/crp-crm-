// Тревоги РОП (PROCESS §11, раздел 6.3): просроченные перезвоны по карточкам (D-050), непринятая передача отделу,
// «серые» консультации без консультанта. Запуск раз в час в рабочие дни. Одна тревога вида на РОП в сутки; пока она не прочитана,
// её числа обновляются (`refresh`), прочитанная не воскрешается. Текст — числа без ПДн.
import { randomUUID } from 'node:crypto';
import type { SystemActor } from '@/server/access';
import { dueBoundsAt } from '@/server/domain/calls/dueBounds';
import { getDb } from '@/server/platform/db';
import { notifyDeps } from './deps';
import { countGreyUnassigned, countUnacceptedHandoffs, insertNotifications, listRecipients, overdueCallbackStats, type NewNotification } from './repo';
import { GREY_WAIT_MIN, type AlarmsReport, type NotifyDeps, type NotifyKind, type RunInput } from './types';

const MIN = 60_000;

export async function runAlarms(_actor: SystemActor, input: RunInput, deps: NotifyDeps = notifyDeps()): Promise<AlarmsReport> {
  const cfg = await deps.config(input.spaceId);
  const day = input.calendar.localDay(input.now);
  const db = await getDb();
  return db.tx(async (tx) => {
    const managers = await listRecipients(tx, { spaceId: cfg.spaceId, roles: cfg.managerRoles });
    const overdue = await overdueCallbackStats(tx, { spaceId: cfg.spaceId, bounds: dueBoundsAt(input.now, cfg.overdueAlertMinutes, input.calendar) });
    const handoffs = await countUnacceptedHandoffs(tx, { spaceId: cfg.spaceId, now: input.now });
    const grey = await countGreyUnassigned(tx, { spaceId: cfg.spaceId, now: input.now, createdBefore: input.now - GREY_WAIT_MIN * MIN });

    const rows: NewNotification[] = [];
    const add = (kind: NotifyKind, params: Record<string, number>) => {
      for (const userId of managers) rows.push({ id: randomUUID(), userId, kind, params, dedupeKey: `alarm:${kind}:${userId}:${day}` });
    };
    if (overdue.count > 0) add('alarm_callbacks_overdue', { count: overdue.count, operators: overdue.operators });
    if (handoffs > 0) add('alarm_handoff_unaccepted', { count: handoffs });
    if (grey > 0) add('alarm_grey_unassigned', { count: grey });

    const written = await insertNotifications(tx, { rows, mode: 'refresh', now: input.now });
    return { overdueCallbacks: overdue.count, handoffs, grey, written };
  });
}
