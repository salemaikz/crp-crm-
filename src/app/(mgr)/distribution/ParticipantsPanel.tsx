'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, EmptyState, Table, type BadgeTone, type TableColumn } from '@/ui/kit';
import { AbsenceDialog, AbsenceList } from './AbsencePanel';
import { call } from './api';
import { formatDay } from './format';
import type { DistributionData, ParticipantRow, ParticipantStatus } from './types';

const TONE: Record<ParticipantStatus, BadgeTone> = { working: 'success', paused: 'warning', absent: 'neutral' };

export function ParticipantsPanel({ data, onChanged }: { data: DistributionData; onChanged: () => void }) {
  const t = useTranslations('distribution');
  const te = useTranslations('distribution.errors');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [absenceFor, setAbsenceFor] = useState<ParticipantRow | null>(null);

  async function togglePause(row: ParticipantRow) {
    if (busy) return;
    setBusy(row.userId);
    setError(null);
    const r = await call<ParticipantRow>('PUT', `/api/distribution/participants/${encodeURIComponent(row.userId)}`, { paused: row.status !== 'paused' });
    setBusy(null);
    if (r.ok) onChanged();
    else setError(r.key);
  }

  async function toggle(row: ParticipantRow, value: boolean) {
    if (busy) return;
    setBusy(row.userId);
    setError(null);
    const r = await call<ParticipantRow>('PUT', `/api/distribution/participants/${encodeURIComponent(row.userId)}`, { inDistribution: value });
    setBusy(null);
    if (r.ok) onChanged();
    else setError(r.key);
  }

  const columns: TableColumn<ParticipantRow>[] = [
    { key: 'name', header: t('participants.columns.name'), primary: true, cell: (p) => <strong>{p.name}</strong> },
    {
      key: 'status',
      header: t('participants.columns.status'),
      cell: (p) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[p.status]}>{t(`participants.status.${p.status}`)}</Badge>
          {p.absentUntil && <span className="text-sm">{t('participants.absentUntil', { day: formatDay(p.absentUntil) })}</span>}
        </span>
      ),
    },
    { key: 'open', header: t('participants.columns.open'), align: 'right', cell: (p) => p.open },
    { key: 'cap', header: t('participants.columns.cap'), align: 'right', cell: (p) => t('participants.capValue', { used: p.capUsed, cap: p.cap }) },
    {
      key: 'in',
      header: t('participants.columns.inDistribution'),
      cell: (p) => (
        <Checkbox
          label={t('participants.columns.inDistribution')}
          aria-label={t('participants.toggle', { name: p.name })}
          checked={p.inDistribution}
          disabled={!data.canManage || busy !== null}
          onChange={(e) => void toggle(p, e.target.checked)}
        />
      ),
    },
    {
      key: 'actions',
      header: t('participants.columns.actions'),
      cell: (p) =>
        data.canManage ? (
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy !== null} aria-label={t(p.status === 'paused' ? 'pause.unsetFor' : 'pause.setFor', { name: p.name })} onClick={() => void togglePause(p)}>
              {t(p.status === 'paused' ? 'pause.unset' : 'pause.set')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy !== null} aria-label={t('absence.openFor', { name: p.name })} onClick={() => setAbsenceFor(p)}>
              {t('absence.open')}
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <>
      {error && <Alert tone="danger">{te(error)}</Alert>}
      <Table
        columns={columns}
        rows={data.participants}
        rowKey={(p) => p.userId}
        empty={<EmptyState framed={false} title={t('participants.empty.title')} description={t('participants.empty.description')} />}
      />
      <AbsenceList data={data} onChanged={onChanged} />
      {absenceFor && <AbsenceDialog key={absenceFor.userId} user={absenceFor} data={data} onClose={() => setAbsenceFor(null)} onSaved={onChanged} />}
    </>
  );
}
