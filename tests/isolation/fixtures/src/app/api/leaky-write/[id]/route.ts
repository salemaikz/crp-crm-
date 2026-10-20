// ПЛОХОЙ: UPDATE без охвата — оператор A меняет карточку оператора B, хотя ответ выглядит как 404.
import { route } from '@/server/access';
import { NotFoundError } from '@/server/access/errors';
import { getDb } from '@/server/platform/db';

export const PATCH = route({ perm: 'card.edit', target: 'object' }, async ({ params }) => {
  const { sql } = await getDb();
  await sql`UPDATE cards SET lpr = 'yes', version = version + 1 WHERE id = ${String(params.id)}`;
  throw new NotFoundError();
});
