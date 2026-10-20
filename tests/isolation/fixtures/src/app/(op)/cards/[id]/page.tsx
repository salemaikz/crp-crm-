// ХОРОШИЙ: страница карточки под page() с охватом.
import { page } from '@/server/access';
import { scopeSql, scoped } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';
import { NotFoundError } from '@/server/access/errors';

export default page<{ params: Promise<{ id: string }> }, React.ReactElement>({ perm: 'card.read', target: 'object' }, async ({ viewer, props }) => {
  const { id } = await props.params;
  const { sql } = await getDb();
  const rows = await scoped(sql)<{ name: string }>`SELECT cl.name FROM cards c JOIN clients cl ON cl.id = c.client_id
                                                  WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  if (!rows[0]) throw new NotFoundError();
  return (
    <main>
      <h1>{rows[0].name}</h1>
    </main>
  );
});
