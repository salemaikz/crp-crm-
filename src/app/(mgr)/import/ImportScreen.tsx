'use client';

import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ImportListItem, ProfileOption } from './types';
import { Badge, Card, EmptyState, Page, PageHeader, Table, type BadgeTone, type TableColumn } from '@/ui/kit';
import { UploadForm } from './UploadForm';

const TONE: Record<ImportListItem['status'], BadgeTone> = { preview: 'info', applied: 'success', failed: 'danger' };

export function ImportScreen({ items, profiles, today }: { items: ImportListItem[]; profiles: ProfileOption[]; today: string }) {
  const t = useTranslations('import');
  const f = useFormatter();
  const labels = new Map(profiles.map((p) => [p.key, p.label]));
  const columns: TableColumn<ImportListItem>[] = [
    { key: 'file', header: t('list.file'), primary: true, cell: (i) => <strong>{i.fileName || t('list.noName')}</strong> },
    { key: 'profile', header: t('list.profile'), cell: (i) => labels.get(i.profileKey) ?? i.profileKey },
    { key: 'rows', header: t('list.rows'), align: 'right', cell: (i) => f.number(i.rows) },
    { key: 'at', header: t('list.at'), cell: (i) => f.dateTime(i.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) },
    {
      key: 'status',
      header: t('list.status'),
      cell: (i) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[i.status]}>{t(`status.${i.status}`)}</Badge>
          {i.rowsExpired && <Badge tone="neutral">{t('list.rowsExpired')}</Badge>}
        </span>
      ),
    },
    {
      key: 'open',
      header: t('list.actions'),
      align: 'right',
      cell: (i) => (
        <Link className="underline" href={`/import/${i.id}`} aria-label={t('list.openFor', { name: i.fileName || t('list.noName') })}>
          {t('list.open')}
        </Link>
      ),
    },
  ];
  return (
    <Page width="wide">
      <PageHeader title={t('title')} lead={t('lead')} />
      <Card className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">{t('upload.title')}</h2>
        {profiles.length === 0 ? <EmptyState framed={false} title={t('upload.noProfiles')} description={t('upload.noProfilesHint')} /> : <UploadForm profiles={profiles} today={today} />}
      </Card>
      <h2 className="mb-3 text-lg font-semibold">{t('list.title')}</h2>
      <Table columns={columns} rows={items} rowKey={(i) => i.id} empty={<EmptyState framed={false} title={t('list.emptyTitle')} description={t('list.emptyHint')} />} />
    </Page>
  );
}
