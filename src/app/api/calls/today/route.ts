import { route } from '@/server/access';
import { callsDeps, getToday } from '@/server/domain/calls';
import { noteDevice, respond } from '../_lib';

/** Сводка «Сегодня» сотрудника за местные сутки: итоги, дозвоны, записи, пропуски. */
export const GET = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    const result = await getToday(callsDeps(), viewer);
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
