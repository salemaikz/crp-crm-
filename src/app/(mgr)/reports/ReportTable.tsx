'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge, EmptyState, Segmented, Table, type TableColumn } from '@/ui/kit';
import { fmtDec, fmtInt, formatDay } from './format';
import { eventTypeShortOf } from './eventTypeLabel';
import { useReasonLabel } from './reasonLabel';
import {
  FUNNEL_KINDS,
  type FunnelKind,
  type AttendanceData,
  type AttendanceListData,
  type AttendanceListRow,
  type AttendanceListStatus,
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
      return <OperatorsTable data={data as OperatorsData} labels={labels} />;
    case 'funnel':
      return <FunnelTable data={data as FunnelData} labels={labels} />;
    case 'revenue':
      return <RevenueTable data={data as RevenueData} labels={labels} />;
    case 'attendance':
      return 'next' in data ? <AttendanceListTable data={data as AttendanceListData} labels={labels} /> : <AttendanceTable data={data as AttendanceData} labels={labels} />;
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

type OpRow = OperatorMetrics & { id: string; name: string; bucket: string; belowTarget: boolean; isTotal: boolean; isAverage?: boolean };

function OperatorsTable({ data, labels }: { data: OperatorsData; labels: ReportLabels }) {
  const t = useTranslations('reports.operators');
  // Названия видов записи — из настроек; вида нет — нейтральный запасной вариант
  const kindHeader = (kind: 'groups' | 'consults'): string => {
    const label = labels.eventKinds[kind === 'groups' ? 'group' : 'individual'];
    return label ? t(`cols.${kind}`, { event: label }) : t(`cols.${kind}Fallback`);
  };
  const rows: OpRow[] = [
    ...data.rows.map((r: OperatorPeriodRow) => ({ ...r, id: `${r.userId}|${r.bucket}`, isTotal: false })),
    { ...data.totals, id: 'total', name: t('total'), bucket: '', belowTarget: false, isTotal: true },
    // Средняя по операторам: только три конверсии; остальные ячейки пустые
    {
      ...data.totals,
      bookedPerConnect: data.average.bookedPerConnect,
      attendedPerBooked: data.average.attendedPerBooked,
      purchasedPerAttended: data.average.purchasedPerAttended,
      id: 'average',
      name: t('average'),
      bucket: '',
      belowTarget: false,
      isTotal: true,
      isAverage: true,
    },
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
    cell: (r) => (r.isAverage ? '' : fmtInt(Number(r[key] ?? 0))),
  });
  const pct = (key: 'attendanceRate' | 'bookedPerConnect' | 'attendedPerBooked' | 'purchasedPerAttended', header: string): TableColumn<OpRow> => ({
    key,
    header,
    numeric: true,
    cell: (r) => (r.isAverage && key === 'attendanceRate' ? '' : <Percent value={r[key]} />),
  });
  cols.push(
    num('issued', t('cols.issued')),
    num('outcomes', t('cols.outcomes')),
    num('connects', t('cols.connects')),
    num('lpr', t('cols.lpr')),
    num('groups', kindHeader('groups')),
    num('consults', kindHeader('consults')),
    num('attended', t('cols.attended')),
    num('noShow', t('cols.noShow')),
    pct('attendanceRate', t('cols.attendanceRate')),
    pct('bookedPerConnect', t('cols.bookedPerConnect')),
    pct('attendedPerBooked', t('cols.attendedPerBooked')),
    pct('purchasedPerAttended', t('cols.purchasedPerAttended')),
    num('purchases', t('cols.purchases')),
    { key: 'purchaseSumKzt', header: t('cols.purchaseSum'), numeric: true, cell: (r) => (r.isAverage ? '' : <Money value={r.purchaseSumKzt} />) },
    num('skips', t('cols.skips')),
    num('workedHours', t('cols.workedHours')),
    {
      key: 'callsPerHour',
      header: t('cols.callsPerHour'),
      numeric: true,
      // Мягкая цель: серая отметка рядом с числом, без красного и без блокировок (PROCESS 10.2)
      cell: (r) =>
        r.isAverage ? (
          ''
        ) : (
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
      <p className="mt-2 text-sm text-[var(--text-2)]">{t('averageHint', { min: data.average.minConnects, count: data.average.operators })}</p>
      {data.callsPerHourTarget !== null && <p className="mt-2 text-sm text-[var(--text-2)]">{t('target', { target: data.callsPerHourTarget })}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Count({ n, rate }: { n: number; rate: number | null }) {
  return (
    <span className="flex flex-col items-end">
      {fmtInt(n)}
      {rate !== null && <span className="text-sm text-[var(--text-2)]">{fmtDec(rate)} %</span>}
    </span>
  );
}

function FunnelTable({ data, labels }: { data: FunnelData; labels: ReportLabels }) {
  const t = useTranslations('reports.funnel');
  const nameOf = (r: FunnelRow) => (data.by === 'source' ? (r.key === '' ? t('unknownSource') : (labels.sources[r.key] ?? r.key)) : (r.name ?? r.key));
  const rows = [...data.rows, { ...data.total, key: '__total' }];
  const step = (s: 'issued' | 'connected' | 'lpr' | 'purchased'): TableColumn<FunnelRow> => ({
    key: s,
    header: t(`steps.${s}`),
    numeric: true,
    cell: (r) => <Count n={r.counts[s]} rate={r.rates[s]} />,
  });
  // «Запись» и «явка» по видам; подпись вида — из настроек, иначе нейтральная из локали
  const kindLabel = (k: FunnelKind) => labels.eventKinds[k] || t(`kindFallback.${k}`);
  const kindCols = FUNNEL_KINDS.flatMap((k): TableColumn<FunnelRow>[] => [
    { key: `${k}Booked`, header: t('kindSteps.booked', { event: kindLabel(k) }), numeric: true, cell: (r) => <Count n={r.kinds[k].booked} rate={r.kindRates[k].booked} /> },
    { key: `${k}Attended`, header: t('kindSteps.attended', { event: kindLabel(k) }), numeric: true, cell: (r) => <Count n={r.kinds[k].attended} rate={r.kindRates[k].attended} /> },
  ]);
  const cols: TableColumn<FunnelRow>[] = [
    { key: 'name', header: t(`key.${data.by}`), primary: true, cell: (r) => <strong>{r.key === '__total' ? t('total') : nameOf(r)}</strong> },
    step('issued'),
    step('connected'),
    step('lpr'),
    ...kindCols,
    step('purchased'),
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

const STATUS_TONE: Record<AttendanceListStatus, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  attended: 'success',
  no_show: 'danger',
  unmarked: 'warning',
  planned: 'info',
  cancelled: 'neutral',
};

/** Поимённый список явки (D-344). Название клиента — ПДн: список приходит только руководителю и директору. */
function AttendanceListTable({ data, labels }: { data: AttendanceListData; labels: ReportLabels }) {
  const t = useTranslations('reports.attendance');
  const dash = t('list.none');
  const cols: TableColumn<AttendanceListRow>[] = [
    // дата и время — одной строкой (дефект 9); вид — короткой подписью из настроек, полная — в title
    { key: 'date', header: t('list.cols.date'), primary: true, nowrap: true, cell: (r) => <strong className="whitespace-nowrap" data-testid="attendance-date">{`${formatDay(r.date)} ${r.startTime}`}</strong> },
    {
      key: 'eventType',
      header: t('list.cols.eventType'),
      nowrap: true,
      cell: (r) => {
        const { short, full } = eventTypeShortOf(labels, r.eventTypeKey);
        return <span title={full} data-testid="attendance-event-type">{short}</span>;
      },
    },
    {
      key: 'client',
      header: t('list.cols.client'),
      // ссылка только если id пришёл с сервера (охват клиента проверяет карточка)
      cell: (r) =>
        r.clientId ? (
          <Link href={`/clients/${encodeURIComponent(r.clientId)}`} className="underline underline-offset-2" data-testid="attendance-client-link">
            {r.clientName}
          </Link>
        ) : (
          r.clientName
        ),
    },
    { key: 'bookedBy', header: t('list.cols.bookedBy'), cell: (r) => r.bookedByName ?? dash },
    { key: 'status', header: t('list.cols.status'), cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{t(`list.status.${r.status}`)}</Badge> },
    { key: 'markedBy', header: t('list.cols.markedBy'), cell: (r) => r.markedByName ?? dash },
    { key: 'consultant', header: t('list.cols.consultant'), cell: (r) => r.consultantName ?? dash },
    { key: 'purchase', header: t('list.cols.purchase'), numeric: true, cell: (r) => (r.purchaseSumKzt === null ? dash : <Money value={r.purchaseSumKzt} />) },
  ];
  return (
    <div className={WRAP}>
      <Table caption={t('list.caption')} captionHidden columns={cols} rows={data.rows} rowKey={(r) => r.bookingId} dense stackOnMobile={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------

// Дефект 9: таблицы блоков «Причины» с одинаковыми колонками: фиксированная раскладка, числовые колонки заданной ширины,
// «Причина» занимает остаток — у всех блоков границы колонок совпадают
const BLOCK_NUM_COL = '84px';
const BLOCK_FIXED = '[&_table]:table-fixed';

function ReasonsTable({ data, labels }: { data: ReasonsData; labels: ReportLabels }) {
  const t = useTranslations('reports.reasons');
  const [view, setView] = useState<'blocks' | 'details'>('blocks');
  const reasonLabel = useReasonLabel(labels);
  if (data.rows.length === 0 && data.blocks.every((b) => b.total === 0)) return <EmptyState title={t('empty')} />;
  const cols: TableColumn<ReasonRow>[] = [
    { key: 'group', header: t('cols.group'), primary: true, cell: (r) => <strong>{t(`groups.${r.group}`)}</strong> },
    { key: 'reason', header: t('cols.reason'), cell: reasonLabel },
    { key: 'count', header: t('cols.count'), numeric: true, cell: (r) => fmtInt(r.count) },
    { key: 'share', header: t('cols.share'), numeric: true, cell: (r) => <Percent value={r.share} /> },
  ];
  const blockCols: TableColumn<ReasonRow>[] = [
    {
      key: 'reason',
      header: t('block.cols.reason'),
      primary: true,
      // итог (группа) — второй строкой: колонок меньше, на телефоне доля не уходит за край
      cell: (r) => (
        <span className="flex flex-col">
          <strong>{reasonLabel(r)}</strong>
          <span className="text-sm" style={{ color: 'var(--text-2)' }}>{t(`groups.${r.group}`)}</span>
        </span>
      ),
    },
    { key: 'count', header: t('block.cols.count'), numeric: true, width: BLOCK_NUM_COL, cell: (r) => fmtInt(r.count) },
    { key: 'share', header: t('block.cols.share'), numeric: true, width: BLOCK_NUM_COL, cell: (r) => <Percent value={r.share} /> },
  ];
  const details = (
    <div className={WRAP}>
      <Table caption={t('caption')} captionHidden columns={cols} rows={data.rows} rowKey={(r) => `${r.group}|${r.reasonCode}`} dense stackOnMobile={false} />
    </div>
  );
  if (data.blocks.length === 0) return details;
  return (
    <div className="flex flex-col gap-4" data-testid="reasons-report">
      <Segmented
        label={t('view.label')}
        items={[
          { id: 'blocks', label: t('view.blocks'), active: view === 'blocks', testId: 'reasons-view-blocks' },
          { id: 'details', label: t('view.details'), active: view === 'details', testId: 'reasons-view-details' },
        ]}
        onSelect={(id) => setView(id === 'details' ? 'details' : 'blocks')}
      />
      {view === 'details' ? (
        details
      ) : (
        data.blocks.map((b) => (
          <section key={b.key} className="flex flex-col gap-2" data-testid={`reasons-block-${b.key}`}>
            <h3 className="flex flex-wrap items-baseline gap-x-3 text-base font-semibold">
              {b.label ?? t(`blockFallback.${b.role}`)}
              <span className="text-sm font-normal" style={{ color: 'var(--text-2)' }}>
                {t('block.total', { n: fmtInt(b.total) })}
              </span>
            </h3>
            {b.rows.length === 0 ? (
              <EmptyState title={t('block.empty')} />
            ) : (
              <div className={`${WRAP} ${BLOCK_FIXED}`}>
                <Table caption={b.label ?? t(`blockFallback.${b.role}`)} captionHidden columns={blockCols} rows={b.rows} rowKey={(r) => `${r.group}|${r.reasonCode}`} dense stackOnMobile={false} />
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
