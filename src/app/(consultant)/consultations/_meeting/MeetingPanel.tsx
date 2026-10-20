'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Select, Textarea, ToastProvider, useToast } from '@/ui/kit';
import { call, newKey } from '@/app/(mgr)/bookings/api';

interface Props {
  bookingId: string;
  version: number;
  status: string;
  cardId: string;
  deal: { version: number; stageKey: string } | null;
  laterStages: { key: string; label: string }[];
  /** Флаг PURCHASES: страница «Покупка» (B6) есть. */
  purchase: boolean;
}

const DAY_MS = 86_400_000;
const WHEN = [
  { key: 'whenTomorrow', days: 1 },
  { key: 'when2', days: 2 },
  { key: 'when3', days: 3 },
  { key: 'whenWeek', days: 7 },
] as const;

export function MeetingPanel(props: Props) {
  return (
    <ToastProvider>
      <Panel {...props} />
    </ToastProvider>
  );
}

function Panel({ bookingId, version, status, cardId, deal, laterStages, purchase }: Props) {
  const t = useTranslations('booking.consultations');
  const te = useTranslations('booking.errors');
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ключи действий живут до успеха: повтор после обрыва связи безопасен (D-205)
  const [attendKey, setAttendKey] = useState(newKey);
  const [resultKey, setResultKey] = useState(newKey);
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'none' | 'call' | 'meeting'>('none');
  const [days, setDays] = useState('1');
  const [toStage, setToStage] = useState('');

  const problem = (code: string) => setError(te.has(code) ? te(code) : te('conflict'));
  const live = status === 'registered' || status === 'confirmed';

  const mark = async (to: 'attended' | 'no_show') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await call('POST', `/api/bookings/${encodeURIComponent(bookingId)}/attendance`, { opId: attendKey, version, to });
    setBusy(false);
    if (!r.ok) {
      // Запись изменилась: показываем актуальную, ключ действия новый
      if (r.status === 409) setAttendKey(newKey());
      return problem(r.code);
    }
    setAttendKey(newKey());
    toast.show({ message: t('attendanceMarked'), tone: 'success' });
    router.refresh();
  };

  const save = async () => {
    if (busy) return;
    if (note.trim() === '' && step === 'none' && toStage === '') return setError(te('empty_result'));
    setBusy(true);
    setError(null);
    const nextStep = step === 'none' ? null : { dueAt: Date.now() + Number(days) * DAY_MS, kind: step };
    const r = await call('POST', `/api/bookings/${encodeURIComponent(bookingId)}/result`, {
      opId: resultKey,
      note,
      nextStep,
      toStageKey: toStage !== '' && deal ? toStage : null,
      dealVersion: toStage !== '' && deal ? deal.version : null,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) setResultKey(newKey());
      return problem(r.code);
    }
    setResultKey(newKey());
    setNote('');
    setStep('none');
    setToStage('');
    toast.show({ message: t('resultSaved'), tone: 'success' });
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {live && (
        <Card as="section">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" size="lg" disabled={busy} onClick={() => void mark('attended')}>
              {t('attended')}
            </Button>
            <Button variant="secondary" size="lg" disabled={busy} onClick={() => void mark('no_show')}>
              {t('noShow')}
            </Button>
          </div>
        </Card>
      )}
      {status === 'no_show' && (
        <Alert tone="warning">
          {t('markFirst')}
          <Button variant="secondary" size="sm" className="ml-2" disabled={busy} onClick={() => void mark('attended')}>
            {t('attended')}
          </Button>
        </Alert>
      )}
      {status === 'attended' && (
        <Card as="section" data-testid="result-form">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('result')}</h2>
            <Badge tone="success">{t('attended')}</Badge>
          </div>
          <div className="flex flex-col gap-3">
            <Field label={t('note')}>
              <Textarea name="result-note" rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Field label={t('nextStep')}>
              <Select name="result-step" value={step} onChange={(e) => setStep(e.target.value === 'call' ? 'call' : e.target.value === 'meeting' ? 'meeting' : 'none')}>
                <option value="none">{t('stepNone')}</option>
                <option value="call">{t('stepCall')}</option>
                <option value="meeting">{t('stepMeeting')}</option>
              </Select>
            </Field>
            {step !== 'none' && (
              <Field label={t('stepWhen')}>
                <Select name="result-when" value={days} onChange={(e) => setDays(e.target.value)}>
                  {WHEN.map((w) => (
                    <option key={w.key} value={w.days}>
                      {t(w.key)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {laterStages.length > 0 && deal && (
              <Field label={t('stageTo')}>
                <Select name="result-stage" value={toStage} onChange={(e) => setToStage(e.target.value)}>
                  <option value="">{t('stageKeep')}</option>
                  {laterStages.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Button variant="primary" size="lg" block disabled={busy} onClick={() => void save()}>
              {t('saveResult')}
            </Button>
          </div>
        </Card>
      )}
      <div className="flex flex-wrap gap-2">
        <Button href={`/bookings/new/${encodeURIComponent(cardId)}`} variant="secondary">
          {t('bookNext')}
        </Button>
        {purchase && (
          <Button href={`/deals/purchase/${encodeURIComponent(cardId)}`} variant="secondary">
            {t('purchase')}
          </Button>
        )}
      </div>
    </div>
  );
}
