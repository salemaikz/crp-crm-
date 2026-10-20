'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Alert, Button, EmptyState, Input, Modal, ToastProvider, useToast } from '@/ui/kit';
import { fetchEvent, fetchGuests, markAttendance, markRest } from './api';
import { GuestItem } from './GuestItem';
import type { DutyEventView, GuestRow } from './types';
import { WalkInSheet } from './WalkInSheet';

interface Props {
  event: DutyEventView;
  guests: GuestRow[];
  typeLabel: string;
}

/** Экран дежурного на телефоне: счётчики, поиск, строки гостей, «Остальные не пришли», «Гость без записи». */
export function DutyBoard(props: Props) {
  return (
    <ToastProvider>
      <Board {...props} />
    </ToastProvider>
  );
}

function Board({ event: initialEvent, guests: initialGuests, typeLabel }: Props) {
  const t = useTranslations('booking.duty');
  const te = useTranslations('booking.errors');
  const tw = useTranslations('booking.walkIn');
  const toast = useToast();
  const [event, setEvent] = useState(initialEvent);
  const [guests, setGuests] = useState(initialGuests);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRest, setConfirmRest] = useState(false);
  const [walkIn, setWalkIn] = useState(false);

  const unmarked = useMemo(() => guests.filter((g) => g.status === 'registered' || g.status === 'confirmed'), [guests]);
  const attended = guests.filter((g) => g.status === 'attended').length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return guests;
    return guests.filter((g) => `${g.clientName} ${g.contactName} ${g.phoneTail}`.toLowerCase().includes(q));
  }, [guests, query]);

  const refresh = async () => {
    const [g, e] = await Promise.all([fetchGuests(event.id), fetchEvent(event.id)]);
    if (g.ok) setGuests(g.data);
    if (e) setEvent(e);
  };

  const mark = async (g: GuestRow, to: 'attended' | 'no_show') => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await markAttendance(g.bookingId, g.version, to);
    if (!r.ok) {
      // Версия устарела (отметил кто-то ещё): перечитываем список и говорим об этом
      if (r.status === 409) toast.show({ message: t('changed'), tone: 'info' });
      else setProblem(te.has(r.code) ? te(r.code) : te('network'));
    }
    await refresh();
    setBusy(false);
  };

  const rest = async () => {
    setBusy(true);
    setConfirmRest(false);
    const r = await markRest(event.id, unmarked.map((g) => g.bookingId));
    if (r.ok) toast.show({ message: t('restDone', { count: r.data.marked }), tone: 'success' });
    else setProblem(te.has(r.code) ? te(r.code) : te('network'));
    await refresh();
    setBusy(false);
  };

  const walkInDone = async (answer: 'found' | 'new' | 'recorded') => {
    setWalkIn(false);
    toast.show({ message: tw(answer), tone: 'success' });
    await refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <section aria-label={typeLabel} className="flex flex-col gap-1">
        <p className="text-base font-medium">
          {typeLabel} · {t('startsAt', { time: event.startTime })}
          {event.location ? ` · ${event.location}` : ''}
        </p>
        <p className="text-sm text-[var(--text-2)]">
          {t('places', { taken: event.seats.taken, capacity: event.capacity })} · <span data-testid="count-unmarked">{t('unmarked', { count: unmarked.length })}</span> ·{' '}
          <span data-testid="count-attended">{t('attendedCount', { count: attended })}</span>
        </p>
      </section>

      {problem && <Alert tone="danger">{problem}</Alert>}

      <Input type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />

      {guests.length === 0 ? (
        <EmptyState title={t('guestsEmpty')} framed={false} />
      ) : (
        <ul className="flex flex-col" aria-label={typeLabel}>
          {shown.map((g) => (
            <GuestItem key={g.bookingId} guest={g} started={event.started} busy={busy} onMark={(row, to) => void mark(row, to)} />
          ))}
        </ul>
      )}

      <div className="sticky bottom-0 flex flex-col gap-2 bg-[var(--bg)] py-3">
        <Button variant="secondary" size="lg" block disabled={busy || !event.started || unmarked.length === 0} onClick={() => setConfirmRest(true)}>
          {t('rest')}
        </Button>
        <Button variant="primary" size="lg" block disabled={busy} onClick={() => setWalkIn(true)}>
          {t('walkIn')}
        </Button>
      </div>

      <Modal
        open={confirmRest}
        onClose={() => setConfirmRest(false)}
        title={t('rest')}
        closeLabel={t('close')}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirmRest(false)}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={() => void rest()}>
              {t('confirm')}
            </Button>
          </>
        }
      >
        <p>{t('restConfirm', { count: unmarked.length })}</p>
      </Modal>

      <WalkInSheet open={walkIn} eventId={event.id} onClose={() => setWalkIn(false)} onDone={(a) => void walkInDone(a)} />
    </div>
  );
}
