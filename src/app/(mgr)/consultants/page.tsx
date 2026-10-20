import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { bookingDeps, listConsultantCandidates, listConsultants, pickLabel } from '@/server/domain/booking';
import { isFeatureEnabled } from '@/server/platform/flags';
import { PageHeader } from '@/ui/kit';
import { ConsultantsBoard } from './_consultants/ConsultantsBoard';

// «Консультанты» РОП (B5a): список с выключенными, добавить, править, выключить. График и день консультаций — за флагом BK_WIZARD.
export default page<object, ReactNode>({ perm: 'booking.manage', target: 'section' }, async ({ viewer }) => {
  const t = await getTranslations('booking.consultants');
  const deps = bookingDeps();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const [consultants, candidates] = await Promise.all([listConsultants(deps, viewer, { includeInactive: true }), listConsultantCandidates(deps, viewer)]);
  const locale = await getLocale();
  const directions = (settings?.catalog.directions ?? []).map((d) => ({ key: d.key, label: pickLabel(d.label, locale) }));
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <PageHeader title={t('title')} />
      <ConsultantsBoard consultants={consultants} candidates={candidates} directions={directions} withSchedule={isFeatureEnabled('BK_WIZARD')} />
    </main>
  );
});
