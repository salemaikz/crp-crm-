'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Field, Select } from '@/ui/kit';
import { call } from './api';
import type { DisableResult, HandoverPreview } from './types';

type Props = {
  userId: string;
  /** Мастер передачи дел включён (`FEATURE_BULK_TRANSFER`); без него предлагается только «срочно». */
  bulkEnabled: boolean;
  onDone: (result: DisableResult) => void;
  onBack: () => void;
};

/**
 * Шаг «Отключить…» (B9a, D-066, D-255): сводка того, что произойдёт, предупреждение «Вход закроется сразу»,
 * «Срочно» (по умолчанию) или «С передачей дел». Повторная отправка безопасна: сервер отвечает прежним итогом.
 */
export function DisableDialog({ userId, bulkEnabled, onDone, onBack }: Props) {
  const t = useTranslations('team');
  const te = useTranslations('team.errors');
  const [preview, setPreview] = useState<HandoverPreview | null>(null);
  const [mode, setMode] = useState<'urgent' | 'wizard'>('urgent');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void call<HandoverPreview>('GET', `/api/team/staff/${encodeURIComponent(userId)}/handover-preview`).then((r) => {
      if (!alive) return;
      if (r.ok) setPreview(r.data);
      else setError(r.key);
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  const wizard = bulkEnabled && mode === 'wizard';
  const to = picked.length === 1 ? { userId: picked[0] as string } : { even: picked };

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const body = wizard && picked.length > 0 ? { mode: 'wizard', to } : { mode: 'urgent' };
    const r = await call<DisableResult>('POST', `/api/team/staff/${encodeURIComponent(userId)}/disable`, body);
    setBusy(false);
    if (r.ok) onDone(r.data);
    else setError(r.key);
  }

  return (
    <div className="flex flex-col gap-4">
      <p>{t('disable.text')}</p>
      <Alert tone="warning">{t('disable.warning')}</Alert>
      {preview === null && !error && <p aria-live="polite">{t('disable.loading')}</p>}
      {preview && (
        <>
          <p>
            {t('disable.summary', {
              working: preview.working,
              untouched: preview.untouched,
              acting: preview.actingCards,
              tasks: preview.tasks,
              bookings: preview.bookings,
              deals: preview.deals,
            })}
          </p>
          {preview.recipient === null ? <Alert tone="danger">{t('disable.noRecipient')}</Alert> : <p className="text-sm text-[var(--text-2)]">{t('disable.recipientHint')}</p>}
        </>
      )}
      {bulkEnabled && (
        <Field label={t('disable.mode')}>
          <Select name="mode" value={mode} onChange={(e) => setMode(e.target.value as 'urgent' | 'wizard')}>
            <option value="urgent">{t('disable.urgent')}</option>
            <option value="wizard">{t('disable.wizard')}</option>
          </Select>
        </Field>
      )}
      {wizard && preview && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm text-[var(--text-2)]">{t('disable.recipients')}</legend>
          <p className="mb-1 text-sm text-[var(--text-2)]">{t('disable.recipientsHint')}</p>
          {preview.candidates.map((c) => (
            <Checkbox
              key={c.userId}
              label={c.name}
              checked={picked.includes(c.userId)}
              onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, c.userId] : cur.filter((x) => x !== c.userId)))}
            />
          ))}
        </fieldset>
      )}
      {error && <Alert tone="danger">{te(error as 'generic')}</Alert>}
      <div className="flex flex-wrap gap-3">
        <Button variant="danger" disabled={busy || (preview === null && !error) || (wizard && picked.length === 0)} onClick={() => void submit()}>
          {t('disable.submit')}
        </Button>
        <Button variant="secondary" onClick={onBack}>
          {t('actions.back')}
        </Button>
      </div>
    </div>
  );
}
