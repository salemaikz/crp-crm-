// Проверки роли и пространства в сервисах записи (docs/booking-design.md §3, D-136).
import { ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import type { Permission } from '@/server/access/types';

/** Пространство запроса; нет активной роли ни в одном — как если бы объекта не существовало. */
export function requireSpace(v: Viewer): string {
  if (v.spaceId === null) throw new NotFoundError();
  return v.spaceId;
}

/**
 * Разрешение именно по роли, а не по отношению: консультант с `booking.create` по `booked_with_me`
 * групповые записи не трогает (D-136). `object` — чужое = несуществующее (404), `section` — 403.
 */
export function requireRole(v: Viewer, perm: Permission, target: 'object' | 'section'): void {
  if (scopeOf(v, perm) !== null) return;
  throw target === 'object' ? new NotFoundError() : new ForbiddenError();
}
