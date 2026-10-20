// Сводка дня РОП: плитки и таблица операторов за сегодня (`report.view`, охват пространства; директору — чтение).
import { route } from '@/server/access';
import { getSummary } from '@/server/domain/reports';

export const GET = route({ perm: 'report.view' }, async ({ viewer }) => {
  const summary = await getSummary(viewer);
  return Response.json(summary, { headers: { 'Cache-Control': 'no-store' } });
});
