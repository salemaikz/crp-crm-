'use client';

import { useTranslations } from 'next-intl';
import { Badge, Table, type BadgeTone, type TableColumn } from '@/ui/kit';
import Link from 'next/link';
import { formatDay, formatSeen } from './format';
import { overdueHref } from './links';
import type { OperatorRow, OperatorStatus, SummaryData } from './types';

const TONE: Record<OperatorStatus, BadgeTone> = { working: 'success', paused: 'warning', absent: 'neutral' };

// Ноутбук (дефект 8): 12 колонок не должны вылезать за окно. Заголовки переносятся по словам, отступы плотнее;
// если места всё равно мало, прокручивается обёртка таблицы (overflow-x у kit), а имя оператора остаётся на месте.
// Числа — tabular-nums (kit: data-numeric). min-w-0: обёртка в сетке экрана не раздувается шире окна.
const TABLE_FIT = 'min-w-0 max-w-full [&_table]:text-sm [&_th]:whitespace-normal [&_th]:px-2 [&_th]:align-bottom [&_th]:leading-tight [&_td]:px-2 [&_td:first-child]:pl-3 [&_th:first-child]:pl-3';

/** Таблица операторов за сегодня; на телефоне строки становятся карточками. */
export function OperatorsTable({ data }: { data: SummaryData }) {
  const t = useTranslations('reports.summary.operators');
  // Названия видов записи — из настроек; вида нет — нейтральный запасной вариант
  const kindHeader = (kind: 'groups' | 'consults'): string => {
    const label = kind === 'groups' ? data.eventLabels.group : data.eventLabels.individual;
    return label === '' ? t(`columns.${kind}Fallback`) : t(`columns.${kind}`, { event: label });
  };
  const columns: TableColumn<OperatorRow>[] = [
    { key: 'name', header: t('columns.name'), primary: true, nowrap: true, cell: (o) => <strong>{o.name}</strong> },
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
    { key: 'issued', header: t('columns.issued'), numeric: true, cell: (o) => t('issuedValue', { issued: o.issued, cap: o.cap }) },
    { key: 'outcomes', header: t('columns.outcomes'), numeric: true, cell: (o) => o.outcomes },
    { key: 'connects', header: t('columns.connects'), numeric: true, cell: (o) => o.connects },
    { key: 'lpr', header: t('columns.lpr'), numeric: true, cell: (o) => o.lpr },
    { key: 'groups', header: kindHeader('groups'), numeric: true, cell: (o) => o.groups },
    { key: 'consults', header: kindHeader('consults'), numeric: true, cell: (o) => o.consults },
    { key: 'skips', header: t('columns.skips'), numeric: true, cell: (o) => o.skips },
    {
      key: 'overdue',
      header: t('columns.overdue'),
      numeric: true,
      cell: (o) => {
        if (o.overdue === 0) return o.overdue;
        const badge = (
          <Badge tone="danger" variant="count">
            {o.overdue}
          </Badge>
        );
        const href = data.board.on ? overdueHref(data.board.callbackTab, o.userId) : null;
        return href ? (
          <Link href={href} aria-label={t('overdueLink', { name: o.name })} data-testid="summary-link-overdue-op">
            {badge}
          </Link>
        ) : (
          badge
        );
      },
    },
    {
      key: 'rate',
      header: t('columns.rate'),
      numeric: true,
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
      numeric: true,
      cell: (o) => (
        <span className="flex flex-col items-end">
          {o.unsent > 0 ? <Badge tone="warning" variant="count">{o.unsent}</Badge> : o.unsent}
          <span className="text-sm">{o.lastSeenAt === null ? t('neverSeen') : t('lastSeen', { time: formatSeen(o.lastSeenAt, data.generatedAt, data.timeZone) })}</span>
        </span>
      ),
    },
  ];
  return <Table caption={t('caption')} columns={columns} rows={data.operators} rowKey={(o) => o.userId} dense stickyFirst captionHidden className={TABLE_FIT} />;
}
