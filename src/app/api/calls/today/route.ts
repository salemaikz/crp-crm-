import { route } from '@/server/access';
import { callsDeps, getToday } from '@/server/domain/calls';
import { noteDevice, respond, wrongAuthor } from '../_lib';

/** Сводка «Сегодня» сотрудника за местные сутки: итоги, дозвоны, записи, пропуски. */
export const GET = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    // Вкладка прежнего сотрудника под cookie нового: данные нового ей не отдаём, статус устройства не пишем (D-292)
    const wrong = wrongAuthor(req, viewer);
    if (wrong) return wrong;
    const result = await getToday(callsDeps(), viewer);
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
