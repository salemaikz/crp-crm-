'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, BottomSheet, Button, Checkbox, Field, Input, Select } from '@/ui/kit';
import { call, newKey } from '../../bookings/api';
import type { ConsultantView, Direction, Person } from './types';

interface Props {
  /** Правка существующего; null — создание. */
  consultant: ConsultantView | null;
  open: boolean;
  candidates: Person[];
  directions: Direction[];
  onClose: () => void;
  onSaved: (c: ConsultantView, created: boolean) => void;
}

const toInt = (s: string, fallback: number) => (/^\d+$/.test(s.trim()) ? Number(s) : fallback);

/** Форма консультанта: сотрудник (при создании), направления, слот, места, автоназначение, порядок. */
export function ConsultantSheet({ consultant, open, candidates, directions, onClose, onSaved }: Props) {
  const t = useTranslations('booking.consultants');
  const te = useTranslations('booking.errors');
  const [requestId, setRequestId] = useState(newKey);
  const [seen, setSeen] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [slotMin, setSlotMin] = useState('45');
  const [capacity, setCapacity] = useState('1');
  const [sort, setSort] = useState('0');
  const [autoAssign, setAutoAssign] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Лист открыт на другом консультанте (или на создании): поля берутся из него
  const marker = open ? (consultant?.id ?? 'new') : null;
  if (marker !== seen) {
    setSeen(marker);
    if (open) {
      setUserId('');
      setPicked(new Set(consultant?.directions ?? []));
      setSlotMin(String(consultant?.slotMin ?? 45));
      setCapacity(String(consultant?.capacity ?? 1));
      setSort(String(consultant?.sort ?? 0));
      setAutoAssign(consultant?.autoAssign ?? true);
      setError(null);
    }
  }

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const values = { directions: [...picked], slotMin: toInt(slotMin, 0), capacity: toInt(capacity, 0), autoAssign, sort: toInt(sort, 0) };
    const r = consultant
      ? await call<ConsultantView>('PATCH', `/api/bookings/consultants/${encodeURIComponent(consultant.id)}`, { seenUpdatedAt: consultant.updatedAt, patch: values })
      : await call<ConsultantView>('POST', '/api/bookings/consultants', { requestId, userId, ...values });
    setBusy(false);
    if (!r.ok) {
      setError(te.has(r.code) ? te(r.code) : te('conflict'));
      // Ключ создания устарел (чужое тело тем же ключом): следующая попытка — новая
      if (!consultant && r.code === 'request_reused') setRequestId(newKey());
      return;
    }
    if (!consultant) setRequestId(newKey());
    onSaved(r.data, consultant === null);
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={consultant ? consultant.name : t('add')}
      closeLabel={t('close')}
      footer={
        <Button variant="primary" size="lg" block disabled={busy || (!consultant && userId === '')} onClick={() => void save()}>
          {t('save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {!consultant && (
          <Field label={t('user')} required>
            <Select name="consultant-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{candidates.length === 0 ? t('noCandidates') : t('pickUser')}</option>
              {candidates.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('directions')}</legend>
          {directions.map((d) => (
            <Checkbox
              key={d.key}
              name={`direction-${d.key}`}
              label={d.label}
              checked={picked.has(d.key)}
              onChange={(e) =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(d.key);
                  else next.delete(d.key);
                  return next;
                })
              }
            />
          ))}
        </fieldset>
        <Field label={t('slot')}>
          <Input name="consultant-slot" inputMode="numeric" value={slotMin} onChange={(e) => setSlotMin(e.target.value)} />
        </Field>
        <Field label={t('capacity')}>
          <Input name="consultant-capacity" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
        <Field label={t('sort')}>
          <Input name="consultant-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
        <Checkbox name="consultant-auto" label={t('autoAssign')} checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
      </div>
    </BottomSheet>
  );
}
