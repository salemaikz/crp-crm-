// Источники данных Viewer: сессия (P3), настройки (P5), лицензия (P10), часы. Подменяются только в
// тестах (testing.ts; в production подмена бросает) — прогон изоляции и интеграционные тесты входят
// «от лица» синтетических сотрудников без cookie и без готового P5.
import { getSession, type SessionInfo } from '@/server/platform/auth/session';
import { getActiveConfig } from '@/server/platform/config/active';
import { isProduction } from '@/server/platform/env';
import { currentLicenseState } from './license';
import type { LicenseState } from './types';

export type AccessResolvers = {
  session: () => Promise<SessionInfo | null>;
  config: () => Promise<unknown>;
  license: () => Promise<LicenseState>;
  now: () => number;
};

const defaults: AccessResolvers = {
  session: getSession,
  config: getActiveConfig,
  license: currentLicenseState,
  now: () => Date.now(),
};

let current: AccessResolvers = { ...defaults };

export function resolvers(): AccessResolvers {
  return current;
}

/** Только тесты: подменить источники. В production — ошибка. */
export function overrideResolvers(patch: Partial<AccessResolvers>): void {
  if (isProduction()) throw new Error('доступ: подмена источников запрещена в production');
  current = { ...current, ...patch };
}

export function resetResolvers(): void {
  current = { ...defaults };
}
