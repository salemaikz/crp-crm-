'use client';

import { useTranslations } from 'next-intl';
import { Badge, EmptyState, Table, type TableColumn } from '@/ui/kit';
import { fmtDec, fmtInt, formatDay } from './format';
import {
  FUNNEL_STEPS,
  type AttendanceData,
  type AttendanceRow,
  type FunnelData,
  type FunnelRow,
  type OperatorMetrics,
  type OperatorPeriodRow,
  type OperatorsData,
  type ReasonsData,
  type ReasonRow,
  type ReportData,
  type ReportKey,
  type ReportLabels,
  type RevenueData,
  type RevenueRow,
} from './types';

/** Одна таблица на отчёт, без графиков (PROCESS 10.2). На телефоне прокручивается по горизонтали, первая колонка закреплена. */
const WRAP = 'min-w-0 [&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-[1] [&_td:first-child]:bg-[var(--surface)] [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-[1] [&_th:first-child]:bg-[var(--surface)]';

type Props = { reportKey: ReportKey; data: ReportData; labels: ReportLabels };

export function ReportTable({ reportKey, data, labels }: Props) {
  switch (reportKey) {
    case 'operators':
      return <OperatorsTable data={data as OperatorsData} />;
    case 'funnel':
      return <FunnelTable data={data as FunnelData} labels={labels} />;
    case 'revenue':
      return <RevenueTable data={data as RevenueData} labels={labels} />;
    case 'attendance':
      return <AttendanceTable data={data as AttendanceData} labels={labels} />;
    case 'reasons':
      return <ReasonsTable data={data as ReasonsData} labels={labels} />;
  }
}

function Money({ value }: { value: number }) {
  const t = useTranslations('reports.page');
  return <>{t('money', { value: fmtInt(value) })}</>;
}

function Percent({ value }: { value: number | null }) {
  const t = useTranslations('reports.page');
  return <>{value === null ? t('none') : t('percent', { value: fmtDec(value) })}</>;
}

// ---------------------------------------------------------------------------

type OpRow = (OperatorMetrics & { id: string; name: string; bucket: string; belowTarget: boolean; isTotal: boolean });

function OperatorsTable({ data }: { data: OperatorsData }) {
  const t = useTranslations('reports.operators');
  const rows: OpRow[] = [
    ...data.rows.map((r: OperatorPeriodRow) => ({ ...r, id: `${r.userId}|${r.bucket}`, isTotal: false })),
    { ...data.totals, id: 'total', name: t('total'), bucket: '', belowTarget: false, isTotal: true },
  ];
  const bucketLabel = (b: string) => (b === 'total' ? t('bucketTotal') : data.grouping === 'week' ? t('bucketWeek', { day: formatDay(b) }) : formatDay(b));
  const cols: TableColumn<OpRow>[] = [
    { key: 'name', header: t('cols.name'), primary: true, cell: (r) => <strong>{r.name}</strong> },
  ];
  if (data.grouping !== 'total') cols.push({ key: 'bucket', header: t('cols.bucket'), cell: (r) => (r.isTotal ? '' : bucketLabel(r.bucket)) });
  const num = (key: keyof OperatorMetrics, header: string): TableColumn<OpRow> => ({
    key,
    header,
    numeric: true,
    cell: (r) => fmtInt(Number(r[key] ?? 0)),
  });
  cols.push(
    num('issued', t('cols.issued')),
    num('outcomes', t('cols.outcomes')),
    num('connects', t('cols.connects')),
    num('lpr', t('cols.lpr')),
    num('groups', t('cols.groups')),
    num('consults', t('cols.consults')),
    num('attended', t('cols.attended')),
    num('noShow', t('cols.noShow')),
    { key: 'attendanceRate', header: t('cols.attendanceRate'), numeric: true, cell: (r) => <Percent value={r.attendanceRate} /> },
    num('purchases', t('cols.purchases')),
    { key: 'purchaseSumKzt', header: t('cols.purchaseSum'), numeric: true, cell: (r) => <Money value={r.purchaseSumKzt} /> },
    num('skips', t('cols.skips')),
    num('workedHours', t('cols.workedHours')),
    {
      key: 'callsPerHour',
      header: t('cols.callsPerHour'),
      numeric: true,
      // Мягкая цель: серая отметка рядом с числом, без красного и без блокировок (PROCESS 10.2)
      cell: (r) => (
        <span className="flex flex-wrap items-center justify-end gap-2">
          {r.callsPerHour === null ? '—' : fmtDec(r.callsPerHour)}
          {r.belowTarget && data.callsPerHourTarget !== null && <Badge tone="neutral">{t('belowTarget', { target: data.callsPerHourTarget })}</Badge>}
        </span>
      ),
    },
  );
  return (
    <div className={WRAP}>
      <Table caption={t('caption')} captionHidden columns={cols} rows={rows} rowKey={(r) => r.id} dense stackOnMobile={false} />
      {data.callsPerHourTarget !== null && <p className="mt-2 text-sm text-[var(--text-2)]">{t('target', { target: data.callsPerHourTarget })}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FunnelTable({ data, labels }: { data: FunnelData; labels: ReportLabels }) {
  const t = useTranslations('reports.funnel');
  const nameOf = (r: FunnelRow) => (data.by === 'source' ? (r.key === '' ? t('unknownSource') : (labels.sources[r.key] ?? r.key)) : (r.name ?? r.key));
  const rows = [...data.rows, { ...data.total, key: '__total' }];
  const cols: TableColumn<FunnelRow>[] = [
    { key: 'name', header: t(`key.${data.by}`), primary: true, cell: (r) => <strong>{r.key === '__total' ? t('total') : nameOf(r)}</strong> },
    ...FUNNEL_STEPS.map(
      (s): TableColumn<FunnelRow> => ({
        key: s,
        header: t(`steps.${s}`),
        numeric: true,
        cell: (r) => (
          <span className="flex flex-col items-end">
            {fmtInt(r.counts[s])}
            {r.rates[s] !== null && <span className="text-sm text-[var(--text-2)]">{fmtDec(r.rates[s] ?? 0)} %</span>}
          </span>
        ),
      }),
    ),
  ];
  return (
    <div className={WRAP}>
      <Table caption={t('caption')} captionHidden columns={cols} rows={rows} rowKey={(r) => r.key} dense stackOnMobile={false} />
      <p className="mt-2 text-sm text-[var(--text-2)]">{t('hint')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RevenueTable({ data, labels }: { data: RevenueData; labels: ReportLabels }) {
  const t = useTranslations('reports.revenue');
  const rows: RevenueRow[] = [...data.rows, { serviceTypeKey: '__total', ...data.total }];
  const money = (key: keyof RevenueRow, header: string): TableColumn<RevenueRow> => ({ key, header, numeric: true, cell: (r) => <Money value={Number(r[key])} /> });
  const num = (key: keyof RevenueRow, header: string): TableColumn<RevenueRow> => ({ key, header, numeric: true, cell: (r) => fmtInt(Number(r[key])) });
  const cols: TableColumn<RevenueRow>[] = [
    {
      key: 'type',
      header: t('cols.type'),
      primary: true,
      cell: (r) => <strong>{r.serviceTypeKey === '__total' ? t('total') : r.serviceTypeKey === '' ? t('noType') : (labels.serviceTypes[r.serviceTypeKey] ?? r.serviceTypeKey)}</strong>,
    },
    num('purchases', t('cols.purchases')),
    money('sumKzt', t('cols.sum')),
    num('firstPurchases', t('cols.firstPurchases')),
    money('firstSumKzt', t('cols.firstSum')),
    num('repeatPurchases', t('cols.repeatPurchases')),
    money('repeatSumKzt', t('cols.repeatSum')),
  ];
  return (
    <div className={WRAP}>
      <Table caption={t('caption')} captionHidden columns={cols} rows={rows} rowKey={(r) => r.serviceTypeKey} dense stackOnMobile={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------

type AttRow = AttendanceRow & { isTotal?: boolean };

function AttendanceTable({ data, labels }: { data: AttendanceData; labels: ReportLabels }) {
  const t = useTranslations('reports.attendance');
  const nameOf = (r: AttendanceRow): string => {
    if (data.by === 'event_type') return labels.eventTypes[r.key] ?? r.key;
    if (r.key === '') return data.by === 'consultant' ? t('grey') : t('noAuthor');
    return r.name || r.key;
  };
  const rows: AttRow[] = [...data.rows, { key: '__total', name: null, ...data.total, isTotal: true }];
  const num = (key: keyof AttendanceRow, header: string): TableColumn<AttRow> => ({ key, header, numeric: true, cell: (r) => fmtInt(Number(r[key])) });
  const cols: TableColumn<AttRow>[] = [
    { key: 'name', header: t(`key.${data.by}`), primary: true, cell: (r) => <strong>{r.isTotal ? t('total') : nameOf(r)}</strong> },
    num('booked', t('cols.booked')),
    num('attended', t('cols.attended')),
    num('noShow', t('cols.noShow')),
    num('unmarked', t('cols.unmarked')),
    num('cancelled', t('cols.cancelled')),
    { key: 'rate', header: t('cols.rate'), numeric: true, cell: (r) => <Percent value={r.rate} /> },
    num('purchases', t('cols.purchases')),
  ];
  return (
    <div className={WRAP}>
      <Table caption={t('caption')} captionHidden columns={cols} rows={rows} rowKey={(r) => r.key} dense stackOnMobile={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReasonsTable({ data, labels }: { data: ReasonsData; labels: ReportLabels }) {
  const t = useTranslations('reports.reasons');
  if (data.rows.length === 0) return <EmptyState title={t('empty')} />;
  const reasonLabel = (r: ReasonRow) => (r.reasonCode === '' ? t('noReason') : (labels.reasons[r.group]?.[r.reasonCode] ?? r.reasonCode));
  const cols: TableColumn<ReasonRow>[] = [
    { key: 'group', header: t('cols.group'), primary: true, cell: (r) => <strong>{t(`groups.${r.group}`)}</strong> },
    { key: 'reason', header: t('cols.reason'), cell: reasonLabel },
    { key: 'count', header: t('cols.count'), numeric: true, cell: (r) => fmtInt(r.count) },
    { key: 'share', header: t('cols.share'), numeric: true, cell: (r) => <Percent value={r.share} /> },
  ];
  return (
    <div className={WRAP}>
      <Table caption={t('caption')} captionHidden columns={cols} rows={data.rows} rowKey={(r) => `${r.group}|${r.reasonCode}`} dense stackOnMobile={false} />
    </div>
  );
}
