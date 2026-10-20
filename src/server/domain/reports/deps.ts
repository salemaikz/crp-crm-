// Зависимости отчётов: настройки и часы. Подмена — только в тестах.
import { isProduction } from '@/server/platform/env';
import { loadReportsConfig } from './settings';
import type { ReportsDeps } from './types';

let override: ReportsDeps | null = null;

export function reportsDeps(): ReportsDeps {
  return override ?? { config: loadReportsConfig, now: () => Date.now() };
}

/** Только тесты: подставить настройки и часы. В production — ошибка. */
export function overrideReportsDepsForTests(deps: ReportsDeps | null): void {
  if (isProduction()) throw new Error('reports: подмена зависимостей запрещена в production');
  override = deps;
}
