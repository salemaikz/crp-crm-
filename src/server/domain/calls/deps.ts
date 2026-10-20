// Зависимости сервисов обзвона: настройки, зависимости записи, часы (docs/calls-design.md).
import { loadCallingContext } from '@/server/domain/cards/settings';
import { bookingDeps } from '@/server/domain/booking/deps';
import { isProduction } from '@/server/platform/env';
import type { CallsDeps } from './types';

let override: CallsDeps | null = null;

export function callsDeps(): CallsDeps {
  return override ?? { context: loadCallingContext, booking: bookingDeps, now: () => Date.now() };
}

/** Только тесты маршрутов: подставить настройки, зависимости записи и часы. В production — ошибка. */
export function overrideCallsDepsForTests(deps: CallsDeps | null): void {
  if (isProduction()) throw new Error('calls: подмена зависимостей запрещена в production');
  override = deps;
}
