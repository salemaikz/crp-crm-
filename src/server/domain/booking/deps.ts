// Зависимости сервисов записи. `cards` — порт из src/server/domain/cards/bookingPort.ts (C5, docs/booking-design.md §12).
import { cardBookingPort } from '@/server/domain/cards/bookingPort';
import { dealLink } from '@/server/domain/deals/effects';
import { isProduction } from '@/server/platform/env';
import { loadBookingSettings } from './settings';
import type { BookingDeps } from './types';

let override: BookingDeps | null = null;

export function bookingDeps(): BookingDeps {
  return override ?? { cards: cardBookingPort, deals: dealLink, settings: loadBookingSettings, now: () => Date.now() };
}

/** Только тесты маршрутов: подставить настройки, порт карточки и часы. В production — ошибка. */
export function overrideBookingDepsForTests(deps: BookingDeps | null): void {
  if (isProduction()) throw new Error('booking: подмена зависимостей запрещена в production');
  override = deps;
}
