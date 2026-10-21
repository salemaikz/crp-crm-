import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { NotFoundError, page } from '@/server/access';
import { pickLabel } from '@/server/domain/booking';
import { dealsDeps, getDealPage } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/ui/kit';
import { DealActions } from '../_components/DealActions';

type Props = { params: Promise<{ dealId: string }> };

// Страница сделки (B6, §5.9): клиент, этап, значки, сумма и услуга покупки, история, записи, передача, действия
// по правам. Чужая сделка — 404. Тексты событий — коды ленты и подписи из настроек, без ПДн.
export default page<Props, ReactNode>({ perm: 'deal.read', target: 'object' }, async ({ viewer, props }) => {
  if (!isFeatureEnabled('PURCHASES')) notFound();
  const { dealId } = await props.params;
  const locale = await getLocale();
  const t = await getTranslations('deals');
  const deps = dealsDeps();
  let view;
  try {
    view = await getDealPage(deps, viewer, dealId);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const tz = settings?.timeZone ?? 'UTC';
  const { deal, pipeline } = view;
  const stage = pipeline.stages.find((s) => s.key === deal.stageKey);
  const stageName = stage ? pickLabel(stage.label, locale) : deal.stageKey;
  const service = settings?.serviceTypes.find((s) => s.key === deal.serviceTypeKey);
  const reason = settings?.lostReasons.find((r) => r.key === deal.lostReasonCode);
  const money = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
  const timeFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
  const historyText = (kind: string) => (t.has(`history.${kind}`) ? t(`history.${kind}`) : t('history.other'));
  const tone = deal.status === 'won' ? 'success' : deal.status === 'lost' ? 'danger' : 'info';

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-4">
      <PageHeader title={view.clientName} lead={`${t('page.title')} · ${pickLabel(pipeline.label, locale)}`} />
      <div className="flex flex-col gap-4">
        <Card as="section" data-testid="deal-summary">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">{stageName}</span>
            <Badge tone={tone}>{t(`page.status.${deal.status}`)}</Badge>
            {deal.needsRebook && <Badge tone="warning">{t('page.needsRebook')}</Badge>}
            {deal.staleDays !== null && <Badge tone="warning">{t('page.stale', { days: deal.staleDays })}</Badge>}
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--text-2)]">{t('page.owner')}</dt>
            <dd>{view.ownerName ?? t('page.noOwner')}</dd>
            {deal.status === 'won' && (
              <>
                <dt className="text-[var(--text-2)]">{t('page.service')}</dt>
                <dd>{service ? pickLabel(service.label, locale) : deal.serviceTypeKey}</dd>
                {deal.amountKzt !== null && (
                  <>
                    <dt className="text-[var(--text-2)]">{t('page.amount')}</dt>
                    <dd data-testid="deal-amount">{`${money.format(deal.amountKzt)} ₸`}</dd>
                  </>
                )}
                <dt className="text-[var(--text-2)]">{t('page.wonAt')}</dt>
                <dd>{deal.wonAt !== null ? dateFmt.format(new Date(deal.wonAt)) : ''}</dd>
              </>
            )}
            {deal.status === 'lost' && deal.lostReasonCode !== '' && (
              <>
                <dt className="text-[var(--text-2)]">{t('page.lostReason')}</dt>
                <dd>{reason ? pickLabel(reason.label, locale) : deal.lostReasonCode}</dd>
              </>
            )}
          </dl>
          <div className="mt-3">
            <Button href={`/clients/${encodeURIComponent(deal.clientId)}`} variant="secondary" size="sm">
              {t('page.toClient')}
            </Button>
          </div>
        </Card>

        <DealActions
          dealId={deal.id}
          cardId={deal.cardId}
          version={deal.version}
          can={view.can}
          amountKzt={deal.amountKzt ?? 0}
          wonDay={deal.wonAt !== null && settings ? settings.calendar.localDay(deal.wonAt) : null}
          stages={pipeline.stages
            .filter((s) => s.kind === 'open' && s.key !== deal.stageKey)
            .map((s) => ({ key: s.key, label: pickLabel(s.label, locale), back: stage ? s.order < stage.order : false, nextTask: s.requires.nextTask }))}
          reasons={(settings?.lostReasons ?? []).map((r) => ({ key: r.key, label: pickLabel(r.label, locale), needsText: r.needsText }))}
        />

        {view.handoff && (
          <Card as="section">
            <h2 className="mb-2 text-base font-semibold">{t('page.handoff')}</h2>
            <p className="text-sm" data-testid="deal-handoff">
              {t(`page.handoffStatus.${view.handoff.status}`)}
            </p>
          </Card>
        )}

        <Card as="section">
          <h2 className="mb-2 text-base font-semibold">{t('page.bookings')}</h2>
          {view.bookings.length === 0 ? (
            <p className="text-sm text-[var(--text-2)]">{t('page.noBookings')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {view.bookings.map((b) => (
                <li key={b.id} className="flex justify-between gap-2">
                  <span>{t('page.bookingRow', { date: b.bookingDate, time: b.startTime })}</span>
                  <span className="text-[var(--text-2)]">{t(`page.bookingStatus.${b.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section">
          <h2 className="mb-2 text-base font-semibold">{t('page.history')}</h2>
          {view.history.length === 0 ? (
            <EmptyState framed={false} title={t('page.noHistory')} />
          ) : (
            <ul className="flex flex-col gap-2 text-sm" data-testid="deal-history">
              {view.history.map((h) => (
                <li key={h.id} className="flex flex-col">
                  <span>{historyText(h.kind)}</span>
                  <span className="text-xs text-[var(--text-2)]">{`${timeFmt.format(new Date(h.at))} · ${h.actorName ?? t('page.systemActor')}`}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
});
