'use client';

import { useTranslations } from 'next-intl';
import { EmptyState, Table, type TableColumn } from '@/ui/kit';
import { formatDateTime, formatDay } from './format';
import type { DistributionData, JournalRowData } from './types';

export function JournalPanel({ data }: { data: DistributionData }) {
  const t = useTranslations('distribution');
  const columns: TableColumn<JournalRowData>[] = [
    { key: 'day', header: t('journal.columns.day'), primary: true, cell: (r) => formatDay(r.day) },
    { key: 'time', header: t('journal.columns.time'), cell: (r) => formatDateTime(r.at, data.timeZone).slice(-5) },
    { key: 'kind', header: t('journal.columns.kind'), cell: (r) => t(`journal.kind.${r.kind}`) },
    { key: 'to', header: t('journal.columns.to'), cell: (r) => r.toName ?? t('journal.pool') },
    { key: 'from', header: t('journal.columns.from'), cell: (r) => r.fromName ?? '—' },
    { key: 'count', header: t('journal.columns.count'), align: 'right', cell: (r) => r.count },
    { key: 'cap', header: t('journal.columns.cap'), align: 'right', cell: (r) => r.countsToCap },
  ];
  return (
    <Table
      columns={columns}
      rows={data.journal}
      rowKey={(r) => `${r.at}|${r.kind}|${r.runId ?? ''}|${r.toName ?? ''}|${r.fromName ?? ''}|${r.actorId ?? ''}`}
      empty={<EmptyState framed={false} title={t('journal.empty.title')} description={t('journal.empty.description')} />}
    />
  );
}
