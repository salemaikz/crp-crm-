// ХОРОШИЙ: чтение карточки с охватом; чужая и несуществующая дают одинаковый 404.
import { route } from '@/server/access';
import { scopeSql, scoped, throwNotFoundOrConflict } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';

export const GET = route({ perm: 'card.read', target: 'object' }, async ({ viewer, params }) => {
  const { sql } = await getDb();
  const id = String(params.id);
  const rows = await scoped(sql)<{ id: string; name: string }>`SELECT c.id, cl.name FROM cards c JOIN clients cl ON cl.id = c.client_id
                                                              WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  if (!rows[0]) await throwNotFoundOrConflict(viewer, sql, 'card', id);
  return rows[0];
});
