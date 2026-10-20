'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, BottomSheet, Button, Card, Chip, EmptyState, ToastProvider, useToast } from '@/ui/kit';
import { call, newKey } from '../../api';
import type { ConsultDayBooking, ConsultDayView, SuggestedConsultant } from './types';

interface Props {
  view: ConsultDayView;
  today: string;
  directions: Record<string, string>;
  locale: string;
}

/** Соседний день по календарной строке (без пояса браузера). */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days, 12));
  return t.toISOString().slice(0, 10);
}

export function ConsultDayBoard(props: Props) {
  return (
    <ToastProvider>
      <Board {...props} />
    </ToastProvider>
  );
}

function Board({ view, today, directions, locale }: Props) {
  const t = useTranslations('booking.consultDay');
  const te = useTranslations('booking.errors');
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState<ConsultDayBooking | null>(null);
  const [candidates, setCandidates] = useState<SuggestedConsultant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${view.date}T12:00:00Z`));
  const dirOf = (key: string) => directions[key] ?? key;
  const problem = (code: string) => (te.has(code) ? te(code) : te('conflict'));

  const open = async (b: ConsultDayBooking) => {
    setTarget(b);
    setCandidates(null);
    setError(null);
    const r = await call<SuggestedConsultant[]>('GET', `/api/bookings/${encodeURIComponent(b.bookingId)}/candidates`);
    if (!r.ok) return setError(problem(r.code));
    setCandidates(r.data);
  };

  const assign = async (resourceId: string) => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    const r = await call('POST', `/api/bookings/${encodeURIComponent(target.bookingId)}/assign`, { opId: newKey(), version: target.version, resourceId });
    setBusy(false);
    if (!r.ok) {
      setError(problem(r.code));
      // Место занято или запись изменилась: список кандидатов перечитываем
      if (r.status === 409) void open(target);
      return;
    }
    setTarget(null);
    toast.show({ message: t('assigned'), tone: 'success' });
    router.refresh();
  };

  const row = (b: ConsultDayBooking, withAssign: boolean) => (
    <li key={b.bookingId}>
      <Card as="article" data-testid="day-booking">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">
              {b.startTime} · {b.clientName || '—'}
            </div>
            <div className="text-sm text-[var(--text-2)]">{dirOf(b.directionKey)}</div>
          </div>
          <div className="flex items-center gap-2">
            {b.isReserve && <Badge tone="warning">{t('reserve')}</Badge>}
            {withAssign && (b.status === 'registered' || b.status === 'confirmed') && (
              <Button variant="secondary" size="sm" onClick={() => void open(b)}>
                {b.resourceId ? t('reassign') : t('assign')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </li>
  );

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label={t('date')} className="flex flex-wrap items-center gap-2">
        <Chip href={`?date=${shift(view.date, -1)}`}>{t('prev')}</Chip>
        <Chip href="?" active={view.date === today}>
          {t('today')}
        </Chip>
        <Chip href={`?date=${shift(view.date, 1)}`}>{t('next')}</Chip>
        <span className="ml-1 font-medium" data-testid="day-title">
          {title}
        </span>
      </nav>

      <section className="flex flex-col gap-2" aria-labelledby="day-unassigned">
        <h2 id="day-unassigned" className="text-lg font-semibold">
          {t('unassigned')}
        </h2>
        {view.unassigned.length === 0 ? <p className="text-sm text-[var(--text-2)]">{t('noUnassigned')}</p> : <ul className="flex flex-col gap-2">{view.unassigned.map((b) => row(b, true))}</ul>}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="day-conflicts">
        <h2 id="day-conflicts" className="text-lg font-semibold">
          {t('conflicts')}
        </h2>
        {view.conflicts.length === 0 ? <p className="text-sm text-[var(--text-2)]">{t('noConflicts')}</p> : <ul className="flex flex-col gap-2">{view.conflicts.map((b) => row(b, true))}</ul>}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="day-consultants">
        <h2 id="day-consultants" className="text-lg font-semibold">
          {t('consultants')}
        </h2>
        {view.consultants.length === 0 && <EmptyState title={t('noConsultants')} />}
        <ul className="flex flex-col gap-2">
          {view.consultants.map((c) => (
            <li key={c.resourceId}>
              <Card as="article" data-testid="day-consultant">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{c.name}</div>
                  <span className="text-sm text-[var(--text-2)]">{c.working && c.hours ? t('hours', c.hours) : t('notWorking')}</span>
                </div>
                {c.slots.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.slots.map((s) => (
                      <Badge key={s.time} tone={s.free > 0 ? 'success' : 'neutral'}>
                        {s.time} · {s.free > 0 ? t('slotFree') : t('slotTaken', { taken: s.taken, capacity: s.capacity })}
                      </Badge>
                    ))}
                  </div>
                )}
                {c.bookings.length > 0 && <ul className="mt-3 flex flex-col gap-2">{c.bookings.map((b) => row(b, true))}</ul>}
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <BottomSheet open={target !== null} onClose={() => setTarget(null)} title={t('candidates')} closeLabel={t('close')}>
        <div className="flex flex-col gap-2">
          {error && <Alert tone="danger">{error}</Alert>}
          {candidates !== null && candidates.length === 0 && <p>{t('noCandidates')}</p>}
          {candidates?.map((c) => (
            <Button key={c.resourceId} variant="secondary" size="lg" block disabled={busy} onClick={() => void assign(c.resourceId)}>
              {c.name}
              {c.directionMatch ? ` · ${t('directionMatch')}` : ''}
            </Button>
          ))}
        </div>
      </BottomSheet>
    </div>
  );
}
