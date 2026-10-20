// Зависимости раздачи: настройки и часы. Подмена — только в тестах.
import { isProduction } from '@/server/platform/env';
import { loadDistributionConfig } from './settings';
import type { DistributionDeps } from './types';

let override: DistributionDeps | null = null;

export function distributionDeps(): DistributionDeps {
  return override ?? { config: loadDistributionConfig, now: () => Date.now() };
}

/** Только тесты маршрутов: подставить настройки и часы. В production — ошибка. */
export function overrideDistributionDepsForTests(deps: DistributionDeps | null): void {
  if (isProduction()) throw new Error('distribution: подмена зависимостей запрещена в production');
  override = deps;
}
