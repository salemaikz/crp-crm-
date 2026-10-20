'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Checkbox, Field, Input, Select } from '@/ui/kit';
import { send } from './api';
import type { SalesSettingsView } from './types';

const EVERY_MIN = [15, 30, 60, 120];

type Props = { data: SalesSettingsView; onSaved: (v: SalesSettingsView) => void; onConflict: () => void };

/** Раздел «Раздача и звонки». Шлёт в патче только изменённые поля. */
export function SalesSettingsForm({ data, onSaved, onConflict }: Props) {
  const t = useTranslations('settings.sales');
  const v = data.values;
  const [dailyCap, setDailyCap] = useState(String(v.dailyCap ?? 0));
  const [from, setFrom] = useState(v.schedule?.from ?? '');
  const [to, setTo] = useState(v.schedule?.to ?? '');
  const [everyMin, setEveryMin] = useState(String(v.schedule?.everyMin ?? 30));
  const [start, setStart] = useState(v.callWindow.start);
  const [end, setEnd] = useState(v.callWindow.end);
  const [noTarget, setNoTarget] = useState(v.callsPerHourTarget === null);
  const [target, setTarget] = useState(String(v.callsPerHourTarget ?? 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const editable = data.can.sales;
  // текущее значение everyMin может быть вне списка (пресет) — оставляем его вариантом
  const everyOptions = EVERY_MIN.includes(v.schedule?.everyMin ?? 30) ? EVERY_MIN : [...EVERY_MIN, v.schedule!.everyMin].sort((a, b) => a - b);

  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (Number(dailyCap) !== v.dailyCap) patch.dailyCap = Number(dailyCap);
    const schedule: Record<string, unknown> = {};
    if (from !== v.schedule?.from) schedule.from = from;
    if (to !== v.schedule?.to) schedule.to = to;
    if (Number(everyMin) !== v.schedule?.everyMin) schedule.everyMin = Number(everyMin);
    if (Object.keys(schedule).length > 0) patch.schedule = schedule;
    const callWindow: Record<string, unknown> = {};
    if (start !== v.callWindow.start) callWindow.start = start;
    if (end !== v.callWindow.end) callWindow.end = end;
    if (Object.keys(callWindow).length > 0) patch.callWindow = callWindow;
    const nextTarget = noTarget ? null : Number(target);
    if (nextTarget !== v.callsPerHourTarget) patch.callsPerHourTarget = nextTarget;
    return patch;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !editable) return;
    setError(null);
    setSaved(false);
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    setBusy(true);
    const r = await send('PATCH', '/api/admin/settings/sales', { expectedRev: data.revs, patch });
    setBusy(false);
    if (r.ok) {
      setSaved(true);
      onSaved(r.data);
    } else if (r.key === 'conflict') onConflict();
    else setError(t(r.key === 'unauthorized' ? 'generic' : r.key));
  }

  return (
    <Card as="section" aria-labelledby="sales-title">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <h2 id="sales-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        {!editable && <Alert tone="info">{data.values.dailyCap === null ? t('noSpace') : t('readOnly')}</Alert>}
        <Field label={t('dailyCap')} hint={t('hints.dailyCap')}>
          <Input name="dailyCap" type="number" inputMode="numeric" min={0} max={500} value={dailyCap} disabled={!editable} onChange={(e) => setDailyCap(e.target.value)} />
        </Field>
        {v.schedule && (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-medium">{t('schedule')}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('scheduleFrom')}>
                <Input name="scheduleFrom" type="time" value={from} disabled={!editable} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={t('scheduleTo')}>
                <Input name="scheduleTo" type="time" value={to} disabled={!editable} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label={t('everyMin')}>
                <Select name="everyMin" value={everyMin} disabled={!editable} onChange={(e) => setEveryMin(e.target.value)}>
                  {everyOptions.map((n) => (
                    <option key={n} value={n}>
                      {t('everyMinOption', { n })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="k-field__hint">{t('hints.schedule')}</p>
          </fieldset>
        )}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">{t('callWindow')}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('callWindowStart')}>
              <Input name="callWindowStart" type="time" value={start} disabled={!editable} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label={t('callWindowEnd')}>
              <Input name="callWindowEnd" type="time" value={end} disabled={!editable} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <p className="k-field__hint">{t('hints.callWindow')}</p>
        </fieldset>
        <Field label={t('callsPerHourTarget')} hint={t('hints.callsPerHourTarget')}>
          <Input name="callsPerHourTarget" type="number" inputMode="numeric" min={1} max={100} value={target} disabled={!editable || noTarget} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Checkbox name="targetNone" label={t('targetNone')} checked={noTarget} disabled={!editable} onChange={(e) => setNoTarget(e.target.checked)} />
        {error && <Alert tone="danger">{error}</Alert>}
        {saved && <Alert tone="success">{t('saved')}</Alert>}
        {editable && (
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? t('saving') : t('save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
