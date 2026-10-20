'use server';
// ХОРОШИЙ: server action под action(); первый аргумент — id объекта.
import { action } from '@/server/access';
import { scopeSql, scoped, throwNotFoundOrConflict } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';

export const markLpr = action({ perm: 'card.edit', target: 'object' }, async ({ viewer }, id: string) => {
  const { sql } = await getDb();
  const rows = await scoped(sql)<{ id: string }>`UPDATE cards c SET lpr = 'yes', version = c.version + 1
                                                  WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.edit')} RETURNING c.id`;
  if (!rows[0]) await throwNotFoundOrConflict(viewer, sql, 'card', id);
  return { id };
});
