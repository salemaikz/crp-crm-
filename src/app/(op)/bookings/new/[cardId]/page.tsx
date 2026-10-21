import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { NotFoundError, page } from '@/server/access';
import { bookingDeps, getBookingWizard } from '@/server/domain/booking';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Page, PageHeader } from '@/ui/kit';
import { BookingWizard } from '../../_wizard/BookingWizard';
import { WizardProviders } from '../../_wizard/WizardProviders';

type Props = { params: Promise<{ cardId: string }> };

// Мастер записи (путь B, D-202): открывается из карточки клиента, задач и «Записей». Чужая карточка — 404,
// как несуществующая. Карточка не в «Договорились»/«Клиент» — экран «Сначала итог» (его решает mode).
export default page<Props, ReactNode>({ perm: 'booking.create', target: 'object' }, async ({ viewer, props }) => {
  const { cardId } = await props.params;
  const t = await getTranslations('booking.wizard');
  let view;
  try {
    view = await getBookingWizard(bookingDeps(), viewer, { cardId, locale: await getLocale() });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return (
    <Page width="form">
      <PageHeader title={t('title')} lead={view.clientName} />
      <WizardProviders>
        <BookingWizard view={view} consultStrip={isFeatureEnabled('BK_WIZARD')} />
      </WizardProviders>
    </Page>
  );
});
