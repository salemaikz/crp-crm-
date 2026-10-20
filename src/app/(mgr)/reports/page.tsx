// Отчёты за период (R3a): вкладки, период, фильтры, одна таблица. Страница с данными: только через page() с правом
// 'report.view'; охват пространства проверяет сервис (оператору и руководителю отдела — 404). Директору — чтение.
// Параметры в адресе: ?r=<отчёт>&from&to&users&source&group&by — ссылкой можно поделиться.
import type { ReactNode } from 'react';
import { BadRequestError, page } from '@/server/access';
import { REPORT_KEYS, getDefaultPeriod, getReport, getReportMeta, parseReportQuery, type ReportKey } from '@/server/domain/reports';
import { ReportsScreen } from './ReportsScreen';
import type { InitialReport, ReportData, ReportMeta, ReportQueryState } from './types';

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default page<Props, ReactNode>({ perm: 'report.view' }, async ({ viewer, props }) => {
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
  return <ReportsScreen meta={meta} initialQuery={query} initial={initial} />;
});
