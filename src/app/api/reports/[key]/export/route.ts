// Выгрузка отчёта за период (R3b §2.3, D-263): ?format=csv|xlsx и те же параметры, что у GET /api/reports/[key]. Право —
// только `report.export` (охват пространства проверяет getReport). Порядок: Sec-Fetch-Site того же сайта → флаг XLSX →
// отчёт → таблица → журнал (до отдачи тела) → файл. Работает при любой лицензии: выгрузка — не мутация (D-054).
import { createTranslator } from 'next-intl';
import { z } from 'zod';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { ForbiddenError, NotFoundError, route } from '@/server/access';
import {
  FILTER_KEYS,
  REPORT_KEYS,
  exportTranslator,
  getDefaultPeriod,
  getReport,
  getReportMeta,
  parseReportQuery,
  toExportTable,
  writeExportLog,
  type ReportKey,
} from '@/server/domain/reports';
import { toExcelCsv, writeXlsx } from '@/server/platform/files';
import { isFeatureEnabled } from '@/server/platform/flags';
import reportsMessages from '../../../../../../messages/ru/reports.json';
import { exportGuard, fileHeaders } from '../../../export/_lib';

const Format = z.enum(['csv', 'xlsx']);
/** Выгрузку запускает только своя страница (или ввод адреса): чужая ссылка не засоряет журнал (D-263). */
const SAME_SITE = new Set(['same-origin', 'none']);

type T = (key: string, values?: Record<string, string | number>) => string;

function reportsT(): T {
  const tr = createTranslator({ locale: DEFAULT_LOCALE, messages: { reports: reportsMessages } as never, namespace: 'reports' as never });
  return (key, values) => (tr as unknown as T)(key, values);
}

export const GET = route({ perm: 'report.export' }, async ({ req, params, viewer }) =>
  exportGuard(async () => {
    const site = req.headers.get('sec-fetch-site');
    if (site !== null && !SAME_SITE.has(site)) throw new ForbiddenError();
    const key = REPORT_KEYS.find((k) => k === params.key);
    if (!key) throw new NotFoundError();
    const sp = Object.fromEntries(new URL(req.url).searchParams);
    const format = Format.parse(sp.format ?? 'csv');
    delete sp.format;
    if (format === 'xlsx' && !isFeatureEnabled('REPORTS_EXPORT')) throw new NotFoundError();

    const { period } = await getDefaultPeriod(viewer);
    const query = parseReportQuery(key as ReportKey, sp, period);
    const report = await getReport(viewer, query);
    const meta = await getReportMeta(viewer);
    const t = exportTranslator(reportsT(), meta.labels);
    const table = toExportTable(query.key, report, t);
    const name = `crm-${key}-${report.period.from}_${report.period.to}.${format}`;
    const body =
      format === 'xlsx'
        ? await writeXlsx({ sheetName: t(`tabs.${key}`), table })
        : toExcelCsv([table.columns.map((c) => c.label), ...table.rows]);

    // журнал — до отдачи тела: строка остаётся, даже если скачивание оборвали; значения фильтров не пишутся
    const filterKeys = FILTER_KEYS.filter((k) => typeof sp[k] === 'string' && sp[k] !== '');
    await writeExportLog(viewer, { kind: 'report', reportKey: key, format, rows: table.rows.length, filterKeys, periodDays: report.period.days });

    const type = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8';
    return new Response(body as BodyInit, { headers: fileHeaders(type, name) });
  }),
);
