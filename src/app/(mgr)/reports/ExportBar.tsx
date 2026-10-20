'use client';

// Выгрузки с экрана отчётов (R3b): CSV и XLSX текущего отчёта — обычные ссылки на скачивание (навигация своего сайта,
// `Sec-Fetch-Site: same-origin`, D-263); полная выгрузка — диалог с паролем; журнал — для администратора и директора.
import { useTranslations } from 'next-intl';
import { Button } from '@/ui/kit';
import { queryString } from './api';
import { FullExportDialog } from './FullExportDialog';
import type { ExportActions, ReportQueryState } from './types';

type Props = { actions: ExportActions; query: ReportQueryState; disabled: boolean };

function exportHref(q: ReportQueryState, format: 'csv' | 'xlsx'): string {
  const sp = queryString(q);
  sp.set('format', format);
  return `/api/reports/${q.key}/export?${sp.toString()}`;
}

export function ExportBar({ actions, query, disabled }: Props) {
  const t = useTranslations('reports');
  if (!actions.csv && !actions.full && !actions.journal) return null;
  return (
    <section aria-label={t('export.label')} className="mb-4 flex flex-wrap items-start gap-2">
      {actions.csv && !disabled && (
        <Button variant="secondary" href={exportHref(query, 'csv')} external download aria-label={`${t('export.label')} ${t('export.csv')}`}>
          {t('export.csv')}
        </Button>
      )}
      {actions.xlsx && !disabled && (
        <Button variant="secondary" href={exportHref(query, 'xlsx')} external download aria-label={`${t('export.label')} ${t('export.xlsx')}`}>
          {t('export.xlsx')}
        </Button>
      )}
      {actions.full && <FullExportDialog limit={actions.fullLimit} />}
      {actions.journal && (
        <Button variant="quiet" href="/reports/exports">
          {t('journal.link')}
        </Button>
      )}
    </section>
  );
}
