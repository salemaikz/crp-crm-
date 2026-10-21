'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, Button, EmptyState, Table, useToast, type TableColumn } from '@/ui/kit';
import { call } from './api';
import { formatDateTime } from './format';
import type { DistributionData, ProposalRowData } from './types';

/**
 * Раздел «Предложены операторами» (D-258): номер и название целиком, совпавший клиент, решение РОП —
 * «Создать» (карточка сразу у предложившего) или «Отклонить». `opId` на строку живёт до успешного ответа.
 */
export function ProposalsPanel({ data, onChanged }: { data: DistributionData; onChanged: () => void }) {
  const t = useTranslations('distribution');
  const te = useTranslations('distribution.errors');
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ops = useRef(new Map<string, string>());

  async function resolve(row: ProposalRowData, decision: 'create' | 'reject') {
    if (busy) return;
    setBusy(row.id);
    setError(null);
    const opId = ops.current.get(row.id) ?? crypto.randomUUID();
    ops.current.set(row.id, opId);
    const r = await call<{ status: 'created' | 'rejected' }>('POST', `/api/distribution/proposals/${encodeURIComponent(row.id)}/resolve`, { opId, decision });
    setBusy(null);
    if (!r.ok) {
      if (r.key !== 'network') ops.current.delete(row.id);
      return setError(r.key);
    }
    ops.current.delete(row.id);
    toast.show({ message: t(decision === 'create' ? 'proposals.created' : 'proposals.rejected'), tone: 'success' });
    onChanged();
  }

  const columns: TableColumn<ProposalRowData>[] = [
    { key: 'name', header: t('proposals.columns.name'), primary: true, cell: (p) => <strong>{p.name}</strong> },
    { key: 'phone', header: t('proposals.columns.phone'), cell: (p) => p.phone },
    { key: 'by', header: t('proposals.columns.by'), cell: (p) => p.userName },
    { key: 'matched', header: t('proposals.columns.matched'), cell: (p) => (p.matchedName ? t('proposals.matched', { name: p.matchedName }) : t('proposals.noMatch')) },
    { key: 'at', header: t('proposals.columns.at'), cell: (p) => formatDateTime(p.createdAt, data.timeZone) },
    {
      key: 'actions',
      header: t('proposals.columns.actions'),
      cell: (p) =>
        data.canIssue ? (
          <span className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={() => void resolve(p, 'create')}>
              {t('proposals.create')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void resolve(p, 'reject')}>
              {t('proposals.reject')}
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <p>{t('proposals.lead')}</p>
      {error && <Alert tone="danger">{te(error)}</Alert>}
      <Table
        columns={columns}
        rows={data.proposals}
        rowKey={(p) => p.id}
        empty={<EmptyState framed={false} title={t('proposals.empty.title')} description={t('proposals.empty.description')} />}
      />
    </>
  );
}
