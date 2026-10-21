// Доступ к отчётам за период и сводке: охват пространства и шире. Оператор, консультант и руководитель отдела — 403.
import { ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import { isFeatureEnabled } from '@/server/platform/flags';

export function requireSpaceReports(v: Viewer): string {
  const scope = scopeOf(v, 'report.view');
  if (scope !== 'space' && scope !== 'all') throw new ForbiddenError();
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
