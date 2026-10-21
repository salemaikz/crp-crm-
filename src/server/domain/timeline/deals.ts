// История сделок клиента (C8, docs/tasks-team-design.md §3.5): сделки, которые зритель видит по охвату `deal.read`.
// Отдел передачи видит только сделку передачи и без суммы (D-300), как на странице сделки.
import type { Viewer } from '@/server/access';
import { seesDealsOnlyAsDepartment } from '@/server/domain/deals/visibility';
import { getDb } from '@/server/platform/db';
import { selectDeals } from './repo';
import type { DealRowDto } from './types';

export async function listClientDeals(viewer: Viewer, clientId: string): Promise<DealRowDto[]> {
  const db = await getDb();
  return selectDeals(db.sql, viewer, clientId, seesDealsOnlyAsDepartment(viewer));
}
