// Настройки применения событий мессенджера: календарь, правила номеров, источники, роли (CONFIG §6).
// Конфигурация уже проверена целиком при загрузке; здесь берётся нужный срез.
import { time } from '@crm/core';
import { getActiveConfig } from '@/server/platform/config/active';
import { clientSearchableKeys } from '../clients/config';
import { loadNotifyConfig } from '../notify';
import type { MessengerSettings } from './types';

/** Нет пространства или набор настроек сломан — применять нечем: событие уйдёт в failed `invalid_settings`. */
export class MessengerSettingsError extends Error {
  override name = 'MessengerSettingsError';
  constructor() {
    super('invalid_settings');
  }
}

export async function loadMessengerSettings(spaceId: string): Promise<MessengerSettings> {
  const cfg = await getActiveConfig();
  const entry = Object.values(cfg.spaces).find((s) => s.spaceId === spaceId);
  if (!entry) throw new MessengerSettingsError();
  const g = cfg.global.doc;
  const s = entry.doc;
  let calendar: time.WorkCalendar;
  try {
    calendar = time.createWorkCalendar({
      timezone: g.org.timezone,
      workdays: g.calendar.workdays,
      workHours: g.calendar.workHours,
      callWindow: g.calendar.callWindow,
      holidays: g.calendar.holidays,
    });
  } catch {
    throw new MessengerSettingsError();
  }
  const notify = await loadNotifyConfig(spaceId);
  return {
    spaceId,
    phoneRules: g.phone,
    calendar,
    replyMinutes: s.tasks.inboundReplyMinutes,
    leadRole: s.distribution.inbound.offHours,
    messengerSources: g.sources.filter((x) => x.kind === 'messenger' && !x.archived).map((x) => x.key),
    searchable: clientSearchableKeys(g, s),
    managerRoles: notify.managerRoles,
  };
}
