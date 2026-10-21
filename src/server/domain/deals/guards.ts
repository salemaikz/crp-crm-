// Проверки флага и пространства в сервисах сделок (B6). Флаг выключен — модуля как бы нет (404, §0 дизайна).
import { NotFoundError, type Viewer } from '@/server/access';
import { isFeatureEnabled } from '@/server/platform/flags';

export function requirePurchases(): void {
  if (!isFeatureEnabled('PURCHASES')) throw new NotFoundError();
}

/** Пространство запроса; нет активной роли — как если бы объекта не существовало. */
export function requireSpace(v: Viewer): string {
  if (v.spaceId === null) throw new NotFoundError();
  return v.spaceId;
}
