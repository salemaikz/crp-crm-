// Неудачи очереди webhook_inbox видны администратору (дизайн §7.7, D-298): строка ушла в failed после всех попыток
// или сразу (`invalid_settings` — например, нет источника вида messenger; ошибка разбора) → уведомление
// `integration_inbox_failed {count}` каждому активному администратору, не чаще раза в местные сутки на подключение.
// В params — только число; текста событий и номеров нет.
import { time } from '@crm/core';
import type { SystemActor } from '@/server/access';
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb } from '@/server/platform/db';
import { activeAdminIds, countFailedInbox, insertAdminNotice } from './repo';

const DAY_MS = 86_400_000;

/** Местные сутки установки; сломанные настройки не должны глушить само уведомление — тогда сутки UTC. */
async function dayOf(now: number): Promise<string> {
  try {
    return time.localDayOf(now, (await getActiveConfig()).global.doc.org.timezone);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

export async function notifyInboxFailed(_actor: SystemActor, a: { integrationId: string; now: number }): Promise<void> {
  const sql = (await getDb()).sql;
  const admins = await activeAdminIds(sql);
  if (admins.length === 0) return;
  // Текущая строка ещё не помечена failed (итог пишет очередь после обработчика): +1
  const count = (await countFailedInbox(sql, { integrationId: a.integrationId, since: a.now - DAY_MS })) + 1;
  const day = await dayOf(a.now);
  for (const userId of admins) {
    await insertAdminNotice(sql, {
      userId,
      kind: 'integration_inbox_failed',
      entityType: 'integration',
      entityId: a.integrationId,
      params: { count },
      dedupeKey: `inbox_failed:${a.integrationId}:${day}:${userId}`,
      now: a.now,
    });
  }
}
