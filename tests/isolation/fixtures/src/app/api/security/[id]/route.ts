// ХОРОШИЙ: мутация безопасности D-054 (securityMutation) — лицензия «только чтение» её не блокирует.
// Объект проверяется с охватом, как у любой другой записи.
import { route } from '@/server/access';
import { scopeSql, scoped, throwNotFoundOrConflict } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';

export const POST = route({ perm: 'authenticated', target: 'object', securityMutation: 'auth.logout_all' }, async ({ viewer, params }) => {
  const { sql } = await getDb();
  const id = String(params.id);
  const rows = await scoped(sql)<{ id: string }>`SELECT c.id FROM cards c WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  if (!rows[0]) await throwNotFoundOrConflict(viewer, sql, 'card', id);
  return { id };
});
