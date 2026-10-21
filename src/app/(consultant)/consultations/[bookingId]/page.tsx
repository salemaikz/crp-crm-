import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { bookingDeps, getMyConsultation, isBookingDomainError, pickLabel } from '@/server/domain/booking';
import { stageFieldLabelsFor } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Button, Card, Page, PageHeader } from '@/ui/kit';
import { MeetingPanel } from '../_meeting/MeetingPanel';

type Props = { params: Promise<{ bookingId: string }> };

const NO_LABELS: Awaited<ReturnType<typeof stageFieldLabelsFor>> = {};

// Страница встречи консультанта (B5c): клиент, сделка, «Пришёл / Не пришёл», итог, запись на следующую консультацию.
// Чужая встреча и встреча вне окна — 404 (как несуществующая). За флагом BK_WIZARD.
export default page<Props, ReactNode>({ perm: 'booking.read', target: 'object' }, async ({ viewer, props }) => {
  if (!isFeatureEnabled('BK_WIZARD')) notFound();
  const { bookingId } = await props.params;
  const t = await getTranslations('booking.consultations');
  const deps = bookingDeps();
  let view;
  try {
    view = await getMyConsultation(deps, viewer, bookingId);
  } catch (e) {
    if (isBookingDomainError(e) && e.code === 'booking_not_found') notFound();
    throw e;
  }
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  // Подписи полей сделки нужны, только если итог может сменить этап (отказ требований этапа, D-301): только поля
  // требований этих этапов и не скрытые роли. Без них — ключи полей, страница из-за настроек сделок не падает
  const labels =
    viewer.spaceId && view.deal && view.laterStages.length > 0
      ? await stageFieldLabelsFor(viewer, { spaceId: viewer.spaceId, pipelineKey: view.deal.pipelineKey, stageKeys: view.laterStages.map((x) => x.key), now: deps.now() }).catch(() => NO_LABELS)
      : NO_LABELS;
  const locale = await getLocale();
  const b = view.booking;
  const dir = settings?.catalog.directions.find((d) => d.key === b.directionKey);
  const when = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${b.bookingDate}T12:00:00Z`));
  return (
    <Page width="form">
      <PageHeader title={view.clientName || t('client')} lead={`${when}, ${b.startTime} · ${t('duration', { minutes: b.durationMin })}${dir ? ` · ${pickLabel(dir.label, locale)}` : ''}`} />
      <div className="flex flex-col gap-4">
        <Card as="section">
          <div className="flex flex-wrap gap-2">
            <Button href={`/clients/${encodeURIComponent(b.clientId)}`} variant="secondary" size="sm">
              {t('toClient')}
            </Button>
            {view.deal && isFeatureEnabled('PURCHASES') && (
              <Button href={`/deals/${encodeURIComponent(view.deal.id)}`} variant="secondary" size="sm">
                {t('toDeal')}
              </Button>
            )}
          </div>
        </Card>
        <MeetingPanel
          bookingId={b.id}
          version={b.version}
          status={b.status}
          cardId={b.cardId}
          deal={view.deal ? { version: view.deal.version, stageKey: view.deal.stageKey } : null}
          laterStages={view.laterStages.map((x) => ({ key: x.key, label: pickLabel(x.label ?? { ru: x.key }, locale) }))}
          purchase={isFeatureEnabled('PURCHASES')}
          fieldLabels={Object.fromEntries(Object.entries(labels).map(([k, l]) => [k, pickLabel(l, locale)]))}
        />
      </div>
    </Page>
  );
});
