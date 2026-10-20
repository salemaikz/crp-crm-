'use client';

import { useTranslations } from 'next-intl';
import { Badge, Table, type BadgeTone, type TableColumn } from '@/ui/kit';
import { formatDay, formatSeen } from './format';
import type { OperatorRow, OperatorStatus, SummaryData } from './types';

const TONE: Record<OperatorStatus, BadgeTone> = { working: 'success', paused: 'warning', absent: 'neutral' };

/** Таблица операторов за сегодня; на телефоне строки становятся карточками. */
export function OperatorsTable({ data }: { data: SummaryData }) {
  const t = useTranslations('reports.summary.operators');
  const columns: TableColumn<OperatorRow>[] = [
    { key: 'name', header: t('columns.name'), primary: true, cell: (o) => <strong>{o.name}</strong> },
    {
      key: 'status',
      header: t('columns.status'),
      cell: (o) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[o.status]}>{t(`status.${o.status}`)}</Badge>
          {o.absentUntil && <span className="text-sm">{t('absentUntil', { day: formatDay(o.absentUntil) })}</span>}
        </span>
      ),
    },
    { key: 'issued', header: t('columns.issued'), align: 'right', cell: (o) => t('issuedValue', { issued: o.issued, cap: o.cap }) },
    { key: 'outcomes', header: t('columns.outcomes'), align: 'right', cell: (o) => o.outcomes },
    { key: 'connects', header: t('columns.connects'), align: 'right', cell: (o) => o.connects },
    { key: 'lpr', header: t('columns.lpr'), align: 'right', cell: (o) => o.lpr },
    { key: 'groups', header: t('columns.groups'), align: 'right', cell: (o) => o.groups },
    { key: 'consults', header: t('columns.consults'), align: 'right', cell: (o) => o.consults },
    { key: 'skips', header: t('columns.skips'), align: 'right', cell: (o) => o.skips },
    {
      key: 'overdue',
      header: t('columns.overdue'),
      align: 'right',
      cell: (o) => (o.overdue > 0 ? <Badge tone="danger">{o.overdue}</Badge> : o.overdue),
    },
    {
      key: 'rate',
      header: t('columns.rate'),
      align: 'right',
      // Мягкая цель: число и отметка «ниже нормы», без красного и без блокировок.
      cell: (o) => (
        <span className="flex flex-wrap items-center justify-end gap-2">
          {o.callsPerHour === null ? t('rateNone') : t('rateValue', { rate: o.callsPerHour })}
          {o.belowTarget && data.callsPerHourTarget !== null && <Badge tone="neutral">{t('belowTarget', { target: data.callsPerHourTarget })}</Badge>}
        </span>
      ),
    },
    {
      key: 'unsent',
      header: t('columns.unsent'),
      align: 'right',
      cell: (o) => (
        <span className="flex flex-col items-end">
          {o.unsent > 0 ? <Badge tone="warning">{o.unsent}</Badge> : o.unsent}
          <span className="text-sm">{o.lastSeenAt === null ? t('neverSeen') : t('lastSeen', { time: formatSeen(o.lastSeenAt, data.generatedAt, data.timeZone) })}</span>
        </span>
      ),
    },
  ];
  return <Table caption={t('caption')} columns={columns} rows={data.operators} rowKey={(o) => o.userId} dense />;
}
