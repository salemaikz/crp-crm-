import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { booking } from '@crm/core';
import { page } from '@/server/access';
import { bookingDeps, getConsultDay, pickLabel } from '@/server/domain/booking';
import { isFeatureEnabled } from '@/server/platform/flags';
import { PageHeader } from '@/ui/kit';
import { ConsultDayBoard } from './_day/ConsultDayBoard';

type Props = { searchParams: Promise<{ date?: string }> };

// День консультаций РОП (B5b, за флагом BK_WIZARD): кто свободен, «серые» заявки, конфликты, назначение.
export default page<Props, ReactNode>({ perm: 'booking.manage', target: 'section' }, async ({ viewer, props }) => {
  if (!isFeatureEnabled('BK_WIZARD')) notFound();
  const t = await getTranslations('booking.consultDay');
  const deps = bookingDeps();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const today = booking.epochToLocalDate(settings?.timeZone ?? viewer.timeZone, deps.now());
  const asked = (await props.searchParams).date;
  const date = asked && booking.isLocalDate(asked) ? asked : today;
  const view = await getConsultDay(deps, viewer, { date });
  const locale = await getLocale();
  const directions = Object.fromEntries((settings?.catalog.directions ?? []).map((d) => [d.key, pickLabel(d.label, locale)]));
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <PageHeader title={t('title')} />
      <ConsultDayBoard view={view} today={today} directions={directions} locale={locale} />
    </main>
  );
});
