// Отчёты за период (R3a): вкладки, период, фильтры, одна таблица. Страница с данными: только через page() с правом
// 'report.view'; охват пространства проверяет сервис (оператору и руководителю отдела — 404). Директору — чтение.
// Параметры в адресе: ?r=<отчёт>&from&to&users&source&group&by — ссылкой можно поделиться.
import type { ReactNode } from 'react';
import { BadRequestError, NotFoundError, can, page } from '@/server/access';
import {
  FULL_EXPORTS_PER_DAY,
  REPORT_KEYS,
  canSeeExportJournal,
  getDefaultPeriod,
  getReport,
  getReportMeta,
  parseReportQuery,
  periodReportsEnabled,
  type ReportKey,
} from '@/server/domain/reports';
import { isFeatureEnabled } from '@/server/platform/flags';
import { DataExportOnly } from './DataExportOnly';
import { ReportsScreen } from './ReportsScreen';
import type { ExportActions, InitialReport, ReportData, ReportMeta, ReportQueryState } from './types';

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default page<Props, ReactNode>({ perm: 'report.view' }, async ({ viewer, props }) => {
  // FEATURE_REPORTS выключен (D-295): отчётов нет, полная выгрузка — есть (D-055); без её права — 404
  if (!periodReportsEnabled()) {
    if (!can(viewer, 'data.export_all')) throw new NotFoundError();
    return <DataExportOnly journal={canSeeExportJournal(viewer)} fullLimit={FULL_EXPORTS_PER_DAY} />;
  }
  const sp = (await props.searchParams) ?? {};
  const params: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) params[k] = first(v);
  const requested = params.r;
  const key: ReportKey = REPORT_KEYS.find((k) => k === requested) ?? 'operators';
  delete params.r;

  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const meta: ReportMeta = await getReportMeta(viewer);
  const { period } = await getDefaultPeriod(viewer);
  let initial: InitialReport = { data: null, error: null };
  let query: ReportQueryState = {
    key,
    from: period.from,
    to: period.to,
    users: [],
    source: '',
    group: 'total',
    funnelBy: 'operator',
    attendanceBy: 'event_type',
  };
  try {
    const q = parseReportQuery(key, params, period);
    query = {
      ...query,
      from: q.period.from,
      to: q.period.to,
      users: q.filters.userIds ?? [],
      source: q.filters.sourceKey ?? '',
      group: q.key === 'operators' ? q.grouping : 'total',
      funnelBy: q.key === 'funnel' ? q.by : 'operator',
      attendanceBy: q.key === 'attendance' ? q.by : 'event_type',
    };
    const data: ReportData = await getReport(viewer, q);
    initial = { data, error: null };
  } catch (e) {
    // неверные параметры адреса — сообщение на экране, а не страница ошибки
    if (e instanceof BadRequestError) initial = { data: null, error: e.detail === 'period_invalid' ? 'period_invalid' : 'invalid' };
    else if ((e as { name?: unknown } | null)?.name === 'ZodError') initial = { data: null, error: 'invalid' };
    else throw e;
  }
  // кнопки выгрузок — по правам и флагу; сервер проверяет то же при каждом запросе
  const csv = can(viewer, 'report.export');
  const actions: ExportActions = {
    csv,
    xlsx: csv && isFeatureEnabled('REPORTS_EXPORT'),
    full: can(viewer, 'data.export_all'),
    journal: canSeeExportJournal(viewer),
    fullLimit: FULL_EXPORTS_PER_DAY,
  };
  return <ReportsScreen meta={meta} initialQuery={query} initial={initial} actions={actions} />;
});
