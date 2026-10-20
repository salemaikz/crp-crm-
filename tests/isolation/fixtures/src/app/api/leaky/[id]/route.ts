// ПЛОХОЙ: обёртка есть, охвата в запросе нет — чужая карточка отдаётся с названием клиента.
import { route } from '@/server/access';
import { NotFoundError } from '@/server/access/errors';
import { getDb } from '@/server/platform/db';

export const GET = route({ perm: 'card.read', target: 'object' }, async ({ params }) => {
  const { sql } = await getDb();
  const rows = await sql<{ id: string; name: string }>`SELECT c.id, cl.name FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE c.id = ${String(params.id)}`;
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
});
