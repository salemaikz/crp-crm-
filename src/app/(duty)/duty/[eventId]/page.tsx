import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { NotFoundError, page } from '@/server/access';
import { bookingDeps, getDutyEvent, isBookingDomainError, listGuests, pickLabel } from '@/server/domain/booking';
import { Page, PageHeader } from '@/ui/kit';
import { DutyBoard } from './_guests/DutyBoard';

type Props = { params: Promise<{ eventId: string }> };

// Дежурство на одном мероприятии (B4, D-072): гости, отметки явки, «Остальные не пришли», гость без записи.
// Не дежурный и не РОП — как несуществующее мероприятие (404).
export default page<Props, ReactNode>({ perm: 'booking.attend', target: 'object' }, async ({ viewer, props }) => {
  const { eventId } = await props.params;
  const t = await getTranslations('booking.duty');
  const deps = bookingDeps();
  let event;
  let guests;
  try {
    event = await getDutyEvent(deps, viewer, eventId);
    guests = await listGuests(deps, viewer, eventId);
  } catch (e) {
    if (e instanceof NotFoundError || (isBookingDomainError(e) && e.code === 'event_not_found')) notFound();
    throw e;
  }
  const settings = await deps.settings(viewer.spaceId as string, deps.now());
  const locale = await getLocale();
  const type = settings.catalog.eventTypes.find((x) => x.key === event.eventTypeKey);
  const typeLabel = type ? pickLabel(type.short, locale) : event.eventTypeKey;
  return (
    <Page width="list">
      <PageHeader title={t('title')} />
      <DutyBoard event={event} guests={guests} typeLabel={typeLabel} />
    </Page>
  );
});
