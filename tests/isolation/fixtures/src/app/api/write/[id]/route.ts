// ХОРОШИЙ: мутация с охватом в самом UPDATE; 0 строк → 404.
import { route } from '@/server/access';
import { scopeSql, scoped, throwNotFoundOrConflict } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';

export const PATCH = route({ perm: 'card.edit', target: 'object' }, async ({ viewer, params }) => {
  const { sql } = await getDb();
  const id = String(params.id);
  const rows = await scoped(sql)<{ id: string }>`UPDATE cards c SET lpr = 'yes', version = c.version + 1
                                                  WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.edit')} RETURNING c.id`;
  if (!rows[0]) await throwNotFoundOrConflict(viewer, sql, 'card', id);
  return { id };
});
