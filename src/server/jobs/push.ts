// Очередь push_outbox (P8b, D-328): наполнение из уведомлений с тихими часами и обработчик отправки.
// Тихие часы: если хоть одно пространство держит `notifications.quietHours = outside_work_hours`, push вне рабочего
// времени ждёт ближайшего рабочего момента календаря установки (PROCESS 11). Нет настроек — без сдвига.
import type { ActiveConfig } from '@crm/core/config';
import { fillPushOutbox, sendPushItem } from '@/server/domain/notify';
import type { SystemActor } from '@/server/access';
import { ConfigMissingError, getActiveConfig } from '@/server/platform/config/active';
import type { Ms, QueueHandler } from '@/server/platform/jobs';
import { calendarFromConfig } from './calendar';

/** Сдвиг момента отправки по тихим часам. */
export function quietShift(cfg: ActiveConfig | null): (at: Ms) => Ms {
  if (!cfg) return (at) => at;
  const quiet = Object.values(cfg.spaces).some((s) => s.doc.notifications.quietHours === 'outside_work_hours');
  if (!quiet) return (at) => at;
  const cal = calendarFromConfig(cfg);
  return (at) => cal.nextWorkingMoment(at);
}

async function activeConfigOrNull(): Promise<ActiveConfig | null> {
  try {
    return await getActiveConfig();
  } catch (e) {
    if (e instanceof ConfigMissingError) return null;
    throw e;
  }
}

export async function pushFill(actor: SystemActor, now: Ms): Promise<number> {
  return fillPushOutbox(actor, { now, nextAt: quietShift(await activeConfigOrNull()) });
}

export function pushHandlers(clock: () => Ms = Date.now): ReadonlyMap<string, QueueHandler> {
  return new Map<string, QueueHandler>([['push', (actor, item) => sendPushItem(actor, item.id, clock())]]);
}
