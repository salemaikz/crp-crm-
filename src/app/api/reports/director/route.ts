// Панель директора (R4): числа текущей (или, по ?week=prev, прошлой) недели и сравнение с предыдущей. `report.view` с охватом пространства; только чтение.
import { route } from '@/server/access';
import { getDirectorDashboard, parseDirectorWeek } from '@/server/domain/reports';

export const GET = route({ perm: 'report.view' }, async ({ req, viewer }) => {
  // ?week=prev — прошлая неделя; неизвестное значение отбрасывается (закрытый список)
  const week = parseDirectorWeek(new URL(req.url).searchParams.get('week'));
  const data = await getDirectorDashboard(viewer, { week });
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
});
