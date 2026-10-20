// Viewer: кто действует в запросе. Строится на каждом запросе: getSession() → users → активное
// членство → раздел ролей текущей ревизии настроек (getActiveConfig, парсится своей схемой Zod).
// Кэша прав нет: отключение, смена роли и передача клиента действуют со следующего запроса.
import type { Permission, Scope } from '@crm/core/access';
import type { Viewer } from './types';

export type BuildViewerOptions = {
  /** Пространство запроса; по умолчанию — пространство по умолчанию или первое с членством. */
  spaceId?: string;
};

/** Собрать Viewer текущего запроса. Нет сессии или учётка отключена — UnauthorizedError. */
export async function buildViewer(opts: BuildViewerOptions = {}): Promise<Viewer> {
  void opts;
  throw new Error('buildViewer: P4a, этап 2');
}

/** Охват роли по разрешению (без отношений); null — не выдано. */
export function scopeOf(viewer: Viewer, perm: Permission): Scope | null {
  void viewer;
  void perm;
  throw new Error('scopeOf: P4a, этап 2');
}

/** Есть ли у сотрудника разрешение хоть в каком-то охвате или через отношение. */
export function can(viewer: Viewer, perm: Permission): boolean {
  void viewer;
  void perm;
  throw new Error('can: P4a, этап 2');
}

/** Нет разрешения → NotFoundError для объекта, ForbiddenError для раздела. */
export function requireAccess(viewer: Viewer, perm: Permission, target: 'object' | 'section'): void {
  void viewer;
  void perm;
  void target;
  throw new Error('requireAccess: P4a, этап 2');
}

/** Назначить роль самому себе нельзя (§5.1 п. 4): ForbiddenError. */
export function assertNotSelf(viewer: Viewer, targetUserId: string): void {
  void viewer;
  void targetUserId;
  throw new Error('assertNotSelf: P4a, этап 2');
}
