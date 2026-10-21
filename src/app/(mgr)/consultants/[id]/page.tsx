import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { bookingDeps, getConsultant, getSchedule, isBookingDomainError } from '@/server/domain/booking';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Page, PageHeader } from '@/ui/kit';
import { ScheduleEditor } from './_schedule/ScheduleEditor';

type Props = { params: Promise<{ id: string }> };

// График консультанта (B5b, за флагом BK_WIZARD): недельные окна и исключения по датам. Чужого и несуществующего нет.
export default page<Props, ReactNode>({ perm: 'booking.manage', target: 'section' }, async ({ viewer, props }) => {
  if (!isFeatureEnabled('BK_WIZARD')) notFound();
  const { id } = await props.params;
  const t = await getTranslations('booking.schedule');
  const deps = bookingDeps();
  try {
    const [consultant, schedule] = await Promise.all([getConsultant(deps, viewer, id), getSchedule(deps, viewer, id)]);
    return (
      <Page width="form">
        <PageHeader title={t('title', { name: consultant.name })} />
        <ScheduleEditor resourceId={consultant.id} initial={schedule} />
      </Page>
    );
  } catch (e) {
    if (isBookingDomainError(e) && e.code === 'consultant_not_found') notFound();
    throw e;
  }
});
