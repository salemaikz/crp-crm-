import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { booking } from '@crm/core';
import { page } from '@/server/access';
import { bookingDeps, listEventsBoard, pickLabel } from '@/server/domain/booking';
import { PageHeader } from '@/ui/kit';
import { EventsBoard } from './_events/EventsBoard';

const MAX_DAYS = 62;

// «Мероприятия» РОП (B4): места, дежурные, отмена на горизонт записи. Действия идут через API записи (B2).
export default page<object, ReactNode>({ perm: 'booking.manage', target: 'section' }, async ({ viewer }) => {
  const t = await getTranslations('booking.events');
  const deps = bookingDeps();
  const now = deps.now();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, now) : null;
  const today = booking.epochToLocalDate(settings?.timeZone ?? viewer.timeZone, now);
  const to = booking.addDays(today, Math.min(settings?.horizonDays ?? 28, MAX_DAYS));
  const board = await listEventsBoard(deps, viewer, { from: today, to });
  const locale = await getLocale();
  const typeLabels = Object.fromEntries((settings?.catalog.eventTypes ?? []).map((x) => [x.key, pickLabel(x.short, locale)]));
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <PageHeader title={t('title')} />
      <EventsBoard events={board.events} candidates={board.candidates} today={today} typeLabels={typeLabels} now={now} />
    </main>
  );
});
