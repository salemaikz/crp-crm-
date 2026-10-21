'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ACTION_SEPARATE, ActionBar, Alert, Badge, Button, Card, EmptyState, Modal, ToastProvider, useToast } from '@/ui/kit';
import { call, newKey } from '../../api';
import { DutySheet } from './DutySheet';
import type { EventBoardItem, Person } from './types';

interface Props {
  events: EventBoardItem[];
  candidates: Person[];
  today: string;
  /** Короткие названия видов по ключу, уже на языке зрителя. */
  typeLabels: Record<string, string>;
  /** «Сейчас» на сервере: мероприятие после этого момента можно отменить. */
  now: number;
}

const dayLabel = (date: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

/** Мероприятия на горизонт записи: места, дежурные, отмена. Ноутбук и телефон. */
export function EventsBoard(props: Props) {
  return (
    <ToastProvider>
      <Board {...props} />
    </ToastProvider>
  );
}

function Board({ events: initial, candidates, today, typeLabels, now }: Props) {
  const t = useTranslations('booking.events');
  const te = useTranslations('booking.errors');
  const locale = useLocale();
  const toast = useToast();
  const [events, setEvents] = useState(initial);
  const [dutyFor, setDutyFor] = useState<EventBoardItem | null>(null);
  const [cancelFor, setCancelFor] = useState<EventBoardItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (events.length === 0) return <EmptyState title={t('empty')} />;

  const groups = new Map<string, EventBoardItem[]>();
  for (const e of events) groups.set(e.eventDate, [...(groups.get(e.eventDate) ?? []), e]);

  const cancel = async () => {
    if (!cancelFor || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await call<{ cancelledBookings: number }>('POST', `/api/events/${encodeURIComponent(cancelFor.id)}/cancel`, { opId: newKey() });
    setBusy(false);
    const id = cancelFor.id;
    setCancelFor(null);
    if (!r.ok) return setProblem(te.has(r.code) ? te(r.code) : te('conflict'));
    setEvents((list) => list.filter((e) => e.id !== id));
    toast.show({ message: t('cancelDone', { count: r.data.cancelledBookings }), tone: 'success' });
  };

  return (
    <div className="flex flex-col gap-5">
      {problem && <Alert tone="danger">{problem}</Alert>}
      {[...groups].map(([date, rows]) => (
        <section key={date} aria-label={date === today ? t('today') : dayLabel(date, locale)} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--text-2)]">{date === today ? t('today') : dayLabel(date, locale)}</h2>
          {rows.map((e) => (
            <Card key={e.id} as="article" data-testid="event-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    <span className="k-num">{e.startTime}</span> · {typeLabels[e.eventTypeKey] ?? e.eventTypeKey}
                    {e.location ? ` · ${e.location}` : ''}
                  </div>
                  <div className="text-sm text-[var(--text-2)]">
                    {t('seats', { taken: e.seats.taken, capacity: e.capacity })}
                    {e.format === 'online' ? ` · ${t('online')}` : ''}
                  </div>
                </div>
                <Badge tone={e.duty.length > 0 ? 'info' : 'neutral'}>{e.duty.length > 0 ? e.duty.map((d) => d.name).join(', ') : t('noDuty')}</Badge>
              </div>
              <ActionBar className="mt-3">
                {e.eventDate === today && (
                  <Button href={`/duty/${e.id}`} variant="secondary" size="sm">
                    {t('toDuty')}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setDutyFor(e)}>
                  {t('setDuty')}
                </Button>
                {e.startsAt > now && (
                  <Button variant="danger-quiet" size="sm" className={ACTION_SEPARATE} onClick={() => setCancelFor(e)}>
                    {t('cancel')}
                  </Button>
                )}
              </ActionBar>
            </Card>
          ))}
        </section>
      ))}

      <DutySheet
        event={dutyFor}
        candidates={candidates}
        onClose={() => setDutyFor(null)}
        onSaved={(id, duty) => {
          setEvents((list) => list.map((e) => (e.id === id ? { ...e, duty } : e)));
          setDutyFor(null);
          toast.show({ message: t('dutySaved'), tone: 'success' });
        }}
      />

      <Modal
        open={cancelFor !== null}
        onClose={() => setCancelFor(null)}
        title={t('cancel')}
        closeLabel={t('close')}
        footer={
          <>
            <Button variant="quiet" onClick={() => setCancelFor(null)}>
              {t('keep')}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
              {t('cancel')}
            </Button>
          </>
        }
      >
        <p>{t('cancelConfirm')}</p>
      </Modal>
    </div>
  );
}
