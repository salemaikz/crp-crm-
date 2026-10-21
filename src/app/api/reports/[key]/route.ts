// Отчёт за период (R3a): operators | funnel | revenue | attendance | reasons. `report.view` с охватом пространства;
// директору — чтение. Неизвестный ключ — 404. Параметры: from, to, users, source, group, by (Zod .strict()).
import { NotFoundError, route } from '@/server/access';
import { REPORT_KEYS, getDefaultPeriod, getReport, parseReportQuery, periodReportsEnabled, type ReportKey } from '@/server/domain/reports';

export const GET = route({ perm: 'report.view' }, async ({ req, params, viewer }) => {
  const key = REPORT_KEYS.find((k) => k === params.key);
  // FEATURE_REPORTS выключен — модуля нет (D-295)
  if (!key || !periodReportsEnabled()) throw new NotFoundError();
  const { period } = await getDefaultPeriod(viewer);
  const query = parseReportQuery(key as ReportKey, Object.fromEntries(new URL(req.url).searchParams), period);
  const report = await getReport(viewer, query);
  return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
});
