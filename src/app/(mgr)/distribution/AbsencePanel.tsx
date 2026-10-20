'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, BottomSheet, Button, Field, Input, Select, Table, useToast, type TableColumn } from '@/ui/kit';
import { call } from './api';
import { formatDay } from './format';
import type { AbsenceRowData, AbsenceSavedData, DistributionData, ParticipantRow } from './types';

/** Значение списка «Кому передать»: пустое — «Поровну между работающими». */
const EVEN = '';

/** Форма «Отсутствует…» для сотрудника: даты, заместитель или «поровну». Нижний лист на телефоне. */
export function AbsenceDialog({
  user,
  data,
  onClose,
  onSaved,
}: {
  user: ParticipantRow | null;
  data: DistributionData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('distribution');
  const te = useTranslations('distribution.errors');
  const toast = useToast();
  const [fromDay, setFromDay] = useState(data.today);
  const [toDay, setToDay] = useState(data.today);
  const [substitute, setSubstitute] = useState(EVEN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Заместитель — работающий участник, кроме самого отсутствующего
  const candidates = data.participants.filter((p) => p.userId !== user?.userId && p.status !== 'absent');

  async function save() {
    if (busy || !user) return;
    setBusy(true);
    setError(null);
    const r = await call<AbsenceSavedData>('POST', '/api/distribution/absences', {
      opId: crypto.randomUUID(),
      userId: user.userId,
      fromDay,
      toDay,
      substituteUserId: substitute === EVEN ? null : substitute,
    });
    setBusy(false);
    if (!r.ok) return setError(r.key);
    toast.show({ message: t('absence.saved', { acting: r.data.applied.acting, released: r.data.applied.released }), tone: 'success' });
    onSaved();
    onClose();
  }

  return (
    <BottomSheet
      open={user !== null}
      onClose={onClose}
      title={t('absence.title', { name: user?.name ?? '' })}
      closeLabel={t('absence.close')}
      footer={
        <>
          <Button disabled={busy || fromDay === '' || toDay === ''} onClick={() => void save()}>
            {t('absence.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('absence.close')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger">{te(error)}</Alert>}
        <Field label={t('absence.from')}>
          <Input type="date" name="absence-from" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
        </Field>
        <Field label={t('absence.to')} hint={t('absence.hint')}>
          <Input type="date" name="absence-to" min={fromDay} value={toDay} onChange={(e) => setToDay(e.target.value)} />
        </Field>
        <Field label={t('absence.substitute')}>
          <Select name="absence-substitute" value={substitute} onChange={(e) => setSubstitute(e.target.value)}>
            <option value={EVEN}>{t('absence.even')}</option>
            {candidates.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </BottomSheet>
  );
}

/** Список действующих и будущих отсутствий с «Отменить» (снимает временных владельцев сразу). */
export function AbsenceList({ data, onChanged }: { data: DistributionData; onChanged: () => void }) {
  const t = useTranslations('distribution');
  const te = useTranslations('distribution.errors');
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(row: AbsenceRowData) {
    if (busy) return;
    setBusy(row.id);
    setError(null);
    const r = await call<AbsenceRowData>('POST', `/api/distribution/absences/${encodeURIComponent(row.id)}/cancel`);
    setBusy(null);
    if (!r.ok) return setError(r.key);
    toast.show({ message: t('absence.cancelled', { name: row.userName }), tone: 'success' });
    onChanged();
  }

  const columns: TableColumn<AbsenceRowData>[] = [
    { key: 'name', header: t('absence.columns.name'), primary: true, cell: (a) => <strong>{a.userName}</strong> },
    { key: 'period', header: t('absence.columns.period'), cell: (a) => t('absence.period', { from: formatDay(a.fromDay), to: formatDay(a.toDay) }) },
    { key: 'substitute', header: t('absence.columns.substitute'), cell: (a) => a.substituteName ?? t('absence.even') },
    {
      key: 'actions',
      header: t('absence.columns.actions'),
      cell: (a) =>
        data.canManage ? (
          <Button variant="secondary" size="sm" disabled={busy !== null} aria-label={t('absence.cancelFor', { name: a.userName })} onClick={() => void cancel(a)}>
            {t('absence.cancel')}
          </Button>
        ) : null,
    },
  ];

  if (data.absences.length === 0) return <p>{t('absence.empty')}</p>;
  return (
    <section aria-label={t('absence.list')} className="flex flex-col gap-3">
      <h3>{t('absence.list')}</h3>
      {error && <Alert tone="danger">{te(error)}</Alert>}
      <Table columns={columns} rows={data.absences} rowKey={(a) => a.id} />
    </section>
  );
}
