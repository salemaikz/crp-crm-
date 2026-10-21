// Доступ к отчётам за период и сводке: охват пространства и шире. Оператор, консультант и руководитель отдела — 403.
import { ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import { isFeatureEnabled } from '@/server/platform/flags';

/**
 * Пускает ли охват роли в отчёты и сводку: пространство или шире. Единая точка правды: её же использует
 * построение меню, чтобы пункт не вёл на 404 у роли с узким охватом (`team`, `own`).
 */
export function canSpaceReports(v: Viewer): boolean {
  const scope = scopeOf(v, 'report.view');
  return scope === 'space' || scope === 'all';
}

export function requireSpaceReports(v: Viewer): string {
  if (!canSpaceReports(v)) throw new ForbiddenError();
  if (v.spaceId === null) throw new NotFoundError();
  return v.spaceId;
}

/** Отчёты за период, их выгрузка и панель директора — за FEATURE_REPORTS (D-295); сводка дня — без флага. */
export function periodReportsEnabled(): boolean {
  return isFeatureEnabled('REPORTS');
}

/** Флаг выключен — модуля нет: 404 до проверки прав (D-017, D-295). Затем — охват пространства. */
export function requirePeriodReports(v: Viewer): string {
  if (!periodReportsEnabled()) throw new NotFoundError();
  return requireSpaceReports(v);
}
