// Зависимости уведомлений: настройки. Подмена — только в тестах.
import { isProduction } from '@/server/platform/env';
import { loadNotifyConfig } from './settings';
import type { NotifyDeps } from './types';

let override: NotifyDeps | null = null;

export function notifyDeps(): NotifyDeps {
  return override ?? { config: loadNotifyConfig };
}

/** Только тесты: подставить настройки. В production — ошибка. */
export function overrideNotifyDepsForTests(deps: NotifyDeps | null): void {
  if (isProduction()) throw new Error('notify: подмена зависимостей запрещена в production');
  override = deps;
}
