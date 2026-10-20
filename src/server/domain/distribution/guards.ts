// Проверки роли и пространства в сервисах раздачи.
import { ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import type { Permission } from '@/server/access/types';

/** Пространство запроса; нет активной роли ни в одном — как если бы раздела не существовало. */
export function requireSpace(v: Viewer): string {
  if (v.spaceId === null) throw new NotFoundError();
  return v.spaceId;
}

/** Разрешение именно по роли (раздел): нет права — 403. */
export function requireRole(v: Viewer, perm: Permission): void {
  if (scopeOf(v, perm) === null) throw new ForbiddenError();
}
