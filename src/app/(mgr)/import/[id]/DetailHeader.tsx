'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button, PageHeader } from '@/ui/kit';
import type { ImportDetails } from '../types';

/** Шапка одной загрузки (обе таблицы): «назад» над заголовком, состояние — бейджем справа от h1 (D-319). */
export function DetailHeader({ details, applied }: { details: ImportDetails; applied: boolean }) {
  const t = useTranslations('import');
  const f = useFormatter();
  const status = applied ? 'applied' : details.status;
  return (
    <PageHeader
      back={
        <Button variant="quiet" size="sm" flush href="/import" className="self-start">
          <ArrowLeft aria-hidden="true" size={16} /> {t('detail.back')}
        </Button>
      }
      title={<span className="break-words">{details.fileName || t('list.noName')}</span>}
      meta={<Badge tone={applied ? 'success' : details.status === 'failed' ? 'danger' : 'info'}>{t(`status.${status}`)}</Badge>}
      lead={t('detail.lead', { rows: f.number(details.rows), at: f.dateTime(details.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) })}
    />
  );
}
