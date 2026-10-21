// Зависимости сервисов сделок: порт карточки (тот же, что у записи, D-248), настройки и часы.
import { cardBookingPort } from '@/server/domain/cards/bookingPort';
import { isProduction } from '@/server/platform/env';
import { loadDealsSettings } from './settings';
import type { DealsDeps } from './types';

let override: DealsDeps | null = null;

export function dealsDeps(): DealsDeps {
  return override ?? { cards: cardBookingPort, settings: loadDealsSettings, now: () => Date.now() };
}

/** Только тесты маршрутов: подставить настройки, порт карточки и часы. В production — ошибка. */
export function overrideDealsDepsForTests(deps: DealsDeps | null): void {
  if (isProduction()) throw new Error('deals: подмена зависимостей запрещена в production');
  override = deps;
}
