import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { booking } from '@crm/core';
import { page } from '@/server/access';
import { bookingDeps, listBookingItems, pickLabel } from '@/server/domain/booking';
import { EmptyState, PageHeader } from '@/ui/kit';
import { BookingList } from './_list/BookingList';

// «Записи» (B3a): только чтение — ближайшие записи по охвату (оператор — свои, РОП — все). Действия, фильтры
// и вид РОП добавляет B3b.
export default page<object, ReactNode>({ perm: 'booking.read', target: 'section' }, async ({ viewer }) => {
  const t = await getTranslations('booking.list');
  const deps = bookingDeps();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const tz = settings?.timeZone ?? viewer.timeZone;
  const today = booking.epochToLocalDate(tz, deps.now());
  const to = booking.addDays(today, settings?.horizonDays ?? 28);
  const items = await listBookingItems(deps, viewer, { from: today, to, status: ['registered', 'confirmed'] });
  const locale = await getLocale();
  const typeLabels = Object.fromEntries((settings?.catalog.eventTypes ?? []).map((x) => [x.key, pickLabel(x.short, locale)]));
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-4">
      <PageHeader title={t('title')} />
      {items.length === 0 ? <EmptyState title={t('empty')} /> : <BookingList items={items} today={today} locale={locale} typeLabels={typeLabels} />}
    </main>
  );
});
