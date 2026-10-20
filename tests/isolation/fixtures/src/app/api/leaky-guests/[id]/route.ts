// ПЛОХОЙ общий объект: мероприятие с охватом, а гости — без охвата записи: чужие клиенты в ответе.
import { route } from '@/server/access';
import { NotFoundError } from '@/server/access/errors';
import { scopeSql, scoped } from '@/server/access/scope';
import { getDb } from '@/server/platform/db';

export const GET = route({ perm: 'booking.read', target: 'object' }, async ({ viewer, params }) => {
  const { sql } = await getDb();
  const id = String(params.id);
  const ev = await scoped(sql)<{ id: string }>`SELECT e.id FROM events e WHERE e.id = ${id} AND ${scopeSql(viewer, 'event', 'booking.read')}`;
  if (!ev[0]) throw new NotFoundError();
  const guests = await sql<{ id: string; name: string }>`SELECT b.id, cl.name FROM bookings b JOIN clients cl ON cl.id = b.client_id WHERE b.event_id = ${id}`;
  return { id, guests };
});
