import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { booking } from '@crm/core';
import { page } from '@/server/access';
import { bookingDeps, listMyConsultations, pickLabel, type MyConsultation } from '@/server/domain/booking';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Badge, Card, EmptyState, Page, PageHeader } from '@/ui/kit';

const HORIZON_DAYS = 30;
const LOOKBACK_DAYS = 30;

// «Мои консультации» (B5c, D-246): записи к своему ресурсу. Имя клиента — только внутри окна доступа (день до встречи
// и 30 дней после); дальше — время и направление. За флагом BK_WIZARD.
export default page<object, ReactNode>({ perm: 'booking.read', target: 'section' }, async ({ viewer }) => {
  if (!isFeatureEnabled('BK_WIZARD')) notFound();
  const t = await getTranslations('booking.consultations');
  const deps = bookingDeps();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const tz = settings?.timeZone ?? viewer.timeZone;
  const today = booking.epochToLocalDate(tz, deps.now());
  const tomorrow = booking.addDays(today, 1);
  const list = await listMyConsultations(deps, viewer, { from: booking.addDays(today, -LOOKBACK_DAYS), to: booking.addDays(today, HORIZON_DAYS) });
  const locale = await getLocale();
  const direction = (key: string) => {
    const d = settings?.catalog.directions.find((x) => x.key === key);
    return d ? pickLabel(d.label, locale) : key;
  };
  const dayLabel = (date: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const live = (c: MyConsultation) => c.status === 'registered' || c.status === 'confirmed';

  const groups: { key: string; title: string; items: MyConsultation[] }[] = [
    { key: 'today', title: t('today'), items: list.filter((c) => c.bookingDate === today) },
    { key: 'tomorrow', title: t('tomorrow'), items: list.filter((c) => c.bookingDate === tomorrow) },
    { key: 'later', title: t('later'), items: list.filter((c) => c.bookingDate > tomorrow) },
    // Прошедшие, но не отмеченные: явка ещё не поставлена
    { key: 'unmarked', title: t('unmarked'), items: list.filter((c) => c.bookingDate < today && live(c)) },
  ];

  const item = (c: MyConsultation) => {
    const body = (
      <Card as="article" interactive={c.inWindow} data-testid="my-consultation">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium">
              {c.bookingDate !== today && `${dayLabel(c.bookingDate)}, `}
              {c.startTime} · {t('duration', { minutes: c.durationMin })}
            </div>
            <div className="text-sm">{c.inWindow ? (c.clientName ?? '—') : <span className="text-[var(--text-2)]">{t('hiddenClient')}</span>}</div>
            <div className="text-sm text-[var(--text-2)]">{direction(c.directionKey)}</div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {c.isReserve && <Badge tone="warning">{t('reserveBadge')}</Badge>}
            {!live(c) && <Badge tone={c.status === 'attended' ? 'success' : 'neutral'}>{c.status === 'attended' ? t('attended') : t('noShow')}</Badge>}
          </div>
        </div>
      </Card>
    );
    return <li key={c.bookingId}>{c.inWindow ? (
          <Link href={`/consultations/${encodeURIComponent(c.bookingId)}`} className="block no-underline">
            {body}
          </Link>
        ) : (
          body
        )}</li>;
  };

  const shown = groups.filter((g) => g.items.length > 0);
  return (
    <Page width="list">
      <PageHeader title={t('title')} />
      {shown.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="flex flex-col gap-5">
          {shown.map((g) => (
            <section key={g.key} aria-labelledby={`grp-${g.key}`} className="flex flex-col gap-2">
              <h2 id={`grp-${g.key}`} className="text-lg font-semibold">
                {g.title}
              </h2>
              <ul className="flex flex-col gap-2">{g.items.map(item)}</ul>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
});
