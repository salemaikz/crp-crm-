// ПЛОХОЙ: охват есть, но чужой объект отличается от несуществующего (403 вместо 404) — выдаёт, что он есть.
import { route } from '@/server/access';
import { ForbiddenError, NotFoundError } from '@/server/access/errors';
import { scopeSql, scoped } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';

export const GET = route({ perm: 'card.read', target: 'object' }, async ({ viewer, params }) => {
  const { sql } = await getDb();
  const id = String(params.id);
  const rows = await scoped(sql)<{ id: string }>`SELECT c.id FROM cards c WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  if (rows[0]) return rows[0];
  const exists = await sql`SELECT 1 FROM cards WHERE id = ${id}`;
  throw exists.length ? new ForbiddenError() : new NotFoundError();
});
