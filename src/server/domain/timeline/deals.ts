// История сделок клиента (C8, docs/tasks-team-design.md §3.5): сделки, которые зритель видит по охвату `deal.read`.
import type { Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { selectDeals } from './repo';
import type { DealRowDto } from './types';

export async function listClientDeals(viewer: Viewer, clientId: string): Promise<DealRowDto[]> {
  const db = await getDb();
  return selectDeals(db.sql, viewer, clientId);
}
