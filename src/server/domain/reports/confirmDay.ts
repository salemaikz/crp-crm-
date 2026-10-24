// День обзвона «подтвердить явку» (D-355) для сводки: окно считает то же ядро, что и доска (`booking.confirmWindow`).
import { booking, time } from '@crm/core';
import type { ConfirmCallCfg } from './types';

/** Сегодня (местный день `localDay`) день обзвона: настройка есть, виды заданы, день недели в списке. */
export function confirmDayActive(cc: ConfirmCallCfg | null, localDay: string): boolean {
  if (!cc || cc.eventTypes.length === 0) return false;
  return booking.confirmWindow(cc, localDay, time.isoWeekday(localDay)).active;
}
