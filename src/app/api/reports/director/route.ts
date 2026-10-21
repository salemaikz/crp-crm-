// Панель директора (R4): числа текущей и прошлой недели. `report.view` с охватом пространства; только чтение.
import { route } from '@/server/access';
import { getDirectorDashboard } from '@/server/domain/reports';

export const GET = route({ perm: 'report.view' }, async ({ viewer }) => {
  const data = await getDirectorDashboard(viewer);
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
});
