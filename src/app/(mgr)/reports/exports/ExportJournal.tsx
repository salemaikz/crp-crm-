'use client';

// Таблица журнала выгрузок: кто, когда, что, сколько строк; фильтры — только названиями. «Показать ещё» — через API.
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, EmptyState, Table, type TableColumn } from '@/ui/kit';
import { fmtInt } from '../format';
import type { JournalPage, JournalRow } from './types';

const REPORT_TABS = new Set(['operators', 'funnel', 'revenue', 'attendance', 'reasons']);
const FILTERS = new Set(['users', 'source', 'group', 'by']);

export function ExportJournal({ initial, timeZone, showBack }: { initial: JournalPage; timeZone: string; showBack: boolean }) {
  const t = useTranslations('reports.journal');
  const tr = useTranslations('reports');
  const fmt = useFormatter();
  const [rows, setRows] = useState<JournalRow[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const more = async () => {
    if (!next || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/export/journal?before=${next.at}:${encodeURIComponent(next.id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as JournalPage;
      setRows((r) => [...r, ...page.rows]);
      setNext(page.next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) return <EmptyState title={t('empty')} />;

  const what = (r: JournalRow): string => {
    const kind = t(`kind.${r.kind}`);
    return r.kind === 'report' && r.reportKey && REPORT_TABS.has(r.reportKey) ? `${kind}: ${tr(`tabs.${r.reportKey}`)}` : kind;
  };
  const cols: TableColumn<JournalRow>[] = [
    {
      key: 'at',
      header: t('cols.at'),
      primary: true,
      cell: (r) => fmt.dateTime(r.at, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }),
    },
    { key: 'actor', header: t('cols.actor'), cell: (r) => r.actorName ?? t('unknownActor') },
    { key: 'kind', header: t('cols.kind'), cell: what },
    { key: 'format', header: t('cols.format'), cell: (r) => r.format.toUpperCase() },
    { key: 'rows', header: t('cols.rows'), align: 'right', cell: (r) => fmtInt(r.rows) },
    { key: 'filters', header: t('cols.filters'), cell: (r) => r.filterKeys.filter((k) => FILTERS.has(k)).map((k) => t(`filters.${k}`)).join(', ') },
    { key: 'period', header: t('cols.period'), cell: (r) => (r.periodDays === null ? '' : t('days', { days: r.periodDays })) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Table caption={t('title')} columns={cols} rows={rows} rowKey={(r) => r.id} dense />
      {failed && <Alert tone="warning">{t('error')}</Alert>}
      {next && (
        <div>
          <Button variant="secondary" onClick={more} disabled={busy}>
            {t('more')}
          </Button>
        </div>
      )}
      {showBack && (
        <div>
          <Button variant="quiet" href="/reports">
            {t('back')}
          </Button>
        </div>
      )}
    </div>
  );
}
