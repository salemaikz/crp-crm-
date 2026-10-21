// Срок, после которого итоги другого сотрудника со свободным текстом удаляются с телефона (D-293 п. 2):
// `calling.offlineWindowHours` из настроек. Серверный модуль: значение уходит в DeviceOwnerGuard страницы.
import { getActiveConfigOrNull } from '@/server/platform/config/active';

const HOUR_MS = 3_600_000;

/**
 * Срок в мс. Пространств несколько — наибольший: итог не удаляется раньше, чем его время сдвинул бы сервер в любом из
 * них. Нет настроек (установка до `crmctl config apply`) — null, итоги только обезличиваются.
 */
export async function foreignOutboxTtlMs(): Promise<number | null> {
  const cfg = await getActiveConfigOrNull();
  const hours = Object.values(cfg?.spaces ?? {}).map((s) => s.doc.calling.offlineWindowHours);
  return hours.length > 0 ? Math.max(...hours) * HOUR_MS : null;
}
