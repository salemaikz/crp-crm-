import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { bookingDeps, listDutyEvents, pickLabel } from '@/server/domain/booking';
import { EmptyState, List, ListItem, PageHeader } from '@/ui/kit';

// «Дежурство» (B4): сегодняшние мероприятия, где вы дежурите (РОП видит все). Одно мероприятие — сразу на него.
export default page<object, ReactNode>({ perm: 'booking.attend', target: 'section' }, async ({ viewer }) => {
  const t = await getTranslations('booking.duty');
  const deps = bookingDeps();
  const events = await listDutyEvents(deps, viewer);
  if (events.length === 1 && events[0]) redirect(`/duty/${events[0].id}`);
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const locale = await getLocale();
  const labels = Object.fromEntries((settings?.catalog.eventTypes ?? []).map((x) => [x.key, pickLabel(x.short, locale)]));
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-4">
      <PageHeader title={t('title')} />
      {events.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <List>
          {events.map((e) => (
            <ListItem
              key={e.id}
              href={`/duty/${e.id}`}
              title={`${e.startTime} · ${labels[e.eventTypeKey] ?? e.eventTypeKey}`}
              meta={[e.location, t('unmarked', { count: e.counts.unmarked }), t('attendedCount', { count: e.counts.attended })].filter((x) => x !== '').join(' · ')}
            />
          ))}
        </List>
      )}
    </main>
  );
});
