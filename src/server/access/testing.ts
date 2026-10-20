// Только для тестов (unit, интеграционные, прогон изоляции): вход «от лица» синтетического
// сотрудника без cookie, подстановка настроек до P5 и часов. В production каждая функция бросает.
// Импорт из src/** запрещается статическим тестом P4b (как и SystemActor вне scripts/jobs).
import type { RoleConfig } from '@crm/core/access';
import type { SessionInfo } from '@/server/platform/auth/session';
import { isProduction } from '@/server/platform/env';
import { overrideResolvers, resetResolvers, type AccessResolvers } from './context';
import { overrideViewer } from './current';
import type { LicenseState, Viewer } from './types';
import { assembleViewer } from './viewer';

function guard(): void {
  if (isProduction()) throw new Error('access/testing: недоступно в production');
}

/** Подменить источники Viewer: сессию, настройки, лицензию, часы. */
export function overrideAccessForTests(patch: Partial<AccessResolvers>): void {
  guard();
  overrideResolvers(patch);
}

/** Войти от лица пользователя: сессия вернёт этот userId (null — без сессии). */
export function signInForTests(userId: string | null): void {
  guard();
  const session: SessionInfo | null = userId ? { userId, sessionId: `test-${userId}`, issuedAt: 0 } : null;
  overrideResolvers({ session: async () => session });
}

/** Подставить готовый Viewer в обёртки (без БД). null — вернуть сборку из БД. */
export function setViewerForTests(viewer: Viewer | null): void {
  guard();
  overrideViewer(viewer ? async () => viewer : null);
}

export function resetAccessForTests(): void {
  resetResolvers();
  overrideViewer(null);
}

/** Viewer из частей без БД — для unit-тестов scopeSql и обёрток. */
export function testViewer(p: {
  userId: string;
  role: RoleConfig | null;
  spaceId?: string | null;
  spaceIds?: readonly string[];
  teamId?: string | null;
  isAdmin?: boolean;
  license?: LicenseState;
  now?: number;
  timeZone?: string;
}): Viewer {
  guard();
  const spaceId = p.spaceId === undefined ? 'space-1' : p.spaceId;
  return assembleViewer({
    userId: p.userId,
    isAdmin: p.isAdmin ?? false,
    spaceId,
    spaceIds: p.spaceIds ?? (spaceId ? [spaceId] : []),
    role: p.role,
    teamId: p.teamId ?? null,
    license: p.license ?? 'valid',
    configRev: null,
    now: p.now ?? Date.UTC(2026, 9, 28, 6, 0),
    timeZone: p.timeZone ?? 'UTC',
  });
}
