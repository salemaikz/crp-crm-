'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Card, Field, Input, Select, ToastProvider, useToast } from '@/ui/kit';
import { call } from '../../../bookings/api';
import type { ConsultantSchedule, TimeRange } from './types';

interface Props {
  resourceId: string;
  initial: ConsultantSchedule;
}

type Windows = Record<number, TimeRange[]>;

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function toWindows(list: ConsultantSchedule['windows']): Windows {
  const out: Windows = {};
  for (const w of list) (out[w.weekday] ??= []).push({ start: w.start, end: w.end });
  return out;
}

/** Окна одного дня: пары «с — до» (type=time), добавить и убрать. Перерыв — промежуток между окнами. */
function WindowsEditor({ value, onChange, idPrefix }: { value: TimeRange[]; onChange: (next: TimeRange[]) => void; idPrefix: string }) {
  const t = useTranslations('booking.schedule');
  const set = (i: number, patch: Partial<TimeRange>) => onChange(value.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="flex flex-col gap-2">
      {value.map((w, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <Field label={t('from')}>
            <Input name={`${idPrefix}-from-${i}`} type="time" value={w.start} onChange={(e) => set(i, { start: e.target.value })} />
          </Field>
          <Field label={t('to')}>
            <Input name={`${idPrefix}-to-${i}`} type="time" value={w.end} onChange={(e) => set(i, { end: e.target.value })} />
          </Field>
          <Button variant="quiet" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            {t('removeWindow')}
          </Button>
        </div>
      ))}
      <div>
        <Button variant="secondary" size="sm" onClick={() => onChange([...value, { start: '09:00', end: '13:00' }])}>
          {t('addWindow')}
        </Button>
      </div>
    </div>
  );
}

/** График консультанта: неделя целиком одним сохранением и исключения по датам (по одному). */
export function ScheduleEditor(props: Props) {
  return (
    <ToastProvider>
      <Editor {...props} />
    </ToastProvider>
  );
}

function Editor({ resourceId, initial }: Props) {
  const t = useTranslations('booking.schedule');
  const te = useTranslations('booking.errors');
  const toast = useToast();
  const base = `/api/bookings/consultants/${encodeURIComponent(resourceId)}`;
  const [week, setWeek] = useState<Windows>(() => toWindows(initial.windows));
  const [exceptions, setExceptions] = useState(initial.exceptions);
  const [hasWeek, setHasWeek] = useState(initial.windows.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Форма нового исключения
  const [day, setDay] = useState('');
  const [kind, setKind] = useState<'off' | 'custom'>('off');
  const [custom, setCustom] = useState<TimeRange[]>([{ start: '09:00', end: '13:00' }]);

  const problem = (code: string) => setError(te.has(code) ? te(code) : te('conflict'));

  const saveWeek = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const windows = WEEKDAYS.flatMap((d) => (week[d] ?? []).map((w) => ({ weekday: d, start: w.start, end: w.end })));
    const r = await call<ConsultantSchedule>('PUT', `${base}/schedule`, { windows });
    setBusy(false);
    if (!r.ok) return problem(r.code);
    setHasWeek(r.data.windows.length > 0);
    setExceptions(r.data.exceptions);
    toast.show({ message: t('weekSaved'), tone: 'success' });
  };

  const saveException = async () => {
    if (busy || day === '') return;
    setBusy(true);
    setError(null);
    const r = await call<ConsultantSchedule>('PUT', `${base}/exceptions/${encodeURIComponent(day)}`, { kind, windows: kind === 'custom' ? custom : [] });
    setBusy(false);
    if (!r.ok) return problem(r.code);
    setExceptions(r.data.exceptions);
    setDay('');
    toast.show({ message: t('exceptionSaved'), tone: 'success' });
  };

  const removeException = async (d: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await call<ConsultantSchedule>('DELETE', `${base}/exceptions/${encodeURIComponent(d)}`);
    setBusy(false);
    if (!r.ok) return problem(r.code);
    setExceptions(r.data.exceptions);
    toast.show({ message: t('exceptionRemoved') });
  };

  return (
    <div className="flex flex-col gap-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <section className="flex flex-col gap-3" aria-labelledby="schedule-week">
        <h2 id="schedule-week" className="text-lg font-semibold">
          {t('week')}
        </h2>
        <p className="text-sm text-[var(--text-2)]">{t('weekHint')}</p>
        {WEEKDAYS.map((d) => (
          <Card key={d} as="section" data-testid={`schedule-day-${d}`}>
            <h3 className="mb-2 font-medium">{t(`weekday.${d}`)}</h3>
            {(week[d] ?? []).length === 0 && <p className="mb-2 text-sm text-[var(--text-2)]">{t('dayOffWeek')}</p>}
            <WindowsEditor idPrefix={`w${d}`} value={week[d] ?? []} onChange={(next) => setWeek((cur) => ({ ...cur, [d]: next }))} />
          </Card>
        ))}
        <div>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void saveWeek()}>
            {t('saveWeek')}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="schedule-exc">
        <h2 id="schedule-exc" className="text-lg font-semibold">
          {t('exceptions')}
        </h2>
        {!hasWeek && <Alert tone="info">{t('needsSchedule')}</Alert>}
        {exceptions.length === 0 ? (
          <p className="text-sm text-[var(--text-2)]">{t('noExceptions')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {exceptions.map((e) => (
              <li key={e.day}>
                <Card as="article" data-testid="schedule-exception">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{e.day}</div>
                      <div className="text-sm text-[var(--text-2)]">{e.kind === 'off' ? t('exceptionOff') : e.windows.map((w) => `${w.start}–${w.end}`).join(', ')}</div>
                    </div>
                    <Button variant="quiet" size="sm" disabled={busy} onClick={() => void removeException(e.day)}>
                      {t('removeException')}
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        <Card tone="dashed">
          <div className="flex flex-col gap-3">
            <Field label={t('exceptionDay')}>
              <Input name="exception-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label={t('exceptionKind')}>
              <Select name="exception-kind" value={kind} onChange={(e) => setKind(e.target.value === 'custom' ? 'custom' : 'off')}>
                <option value="off">{t('exceptionOff')}</option>
                <option value="custom">{t('exceptionCustom')}</option>
              </Select>
            </Field>
            {kind === 'custom' && <WindowsEditor idPrefix="exc" value={custom} onChange={setCustom} />}
            <div>
              <Button variant="secondary" disabled={busy || day === ''} onClick={() => void saveException()}>
                {t('addException')}
              </Button>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
