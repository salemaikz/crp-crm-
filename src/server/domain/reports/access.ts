// Доступ к отчётам за период и сводке: охват пространства и шире. Оператор, консультант и руководитель отдела — 403.
import { ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';

export function requireSpaceReports(v: Viewer): string {
  const scope = scopeOf(v, 'report.view');
  if (scope !== 'space' && scope !== 'all') throw new ForbiddenError();
  if (v.spaceId === null) throw new NotFoundError();
  return v.spaceId;
}
