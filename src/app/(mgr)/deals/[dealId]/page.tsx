import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { NotFoundError, page } from '@/server/access';
import { pickLabel } from '@/server/domain/booking';
import { dealsDeps, getDealPage } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Badge, Button, Card, DataList, EmptyState, Page, PageHeader, type DataListItem } from '@/ui/kit';
import { DealActions } from '../_components/DealActions';
import { bookingDayLabel, historyLabelKey } from '../_components/dealFormat';

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
  const historyText = (kind: string) => t(`history.${historyLabelKey(kind, (k) => t.has(`history.${k}`))}`);
  const summary: DataListItem[] = [
    { label: t('page.owner'), value: view.ownerName ?? t('page.noOwner') },
    ...(deal.status === 'won'
      ? [
          { label: t('page.service'), value: service ? pickLabel(service.label, locale) : deal.serviceTypeKey },
          ...(deal.amountKzt !== null ? [{ label: t('page.amount'), value: <span className="k-num" data-testid="deal-amount">{`${money.format(deal.amountKzt)} ₸`}</span> }] : []),
          { label: t('page.wonAt'), value: deal.wonAt !== null ? dateFmt.format(new Date(deal.wonAt)) : '' },
        ]
      : []),
    ...(deal.status === 'lost' && deal.lostReasonCode !== ''
      ? [{ label: t('page.lostReason'), value: reason ? pickLabel(reason.label, locale) : deal.lostReasonCode }]
      : []),
  ];
  const tone = deal.status === 'won' ? 'success' : deal.status === 'lost' ? 'danger' : 'info';

  return (
    <Page width="form">
      <PageHeader
        title={view.clientName}
        lead={`${t('page.title')} · ${pickLabel(pipeline.label, locale)}`}
        actions={
          <Button href={`/clients/${encodeURIComponent(deal.clientId)}`} variant="secondary" size="sm">
            {t('page.toClient')}
          </Button>
        }
      />
      <div className="flex flex-col gap-[var(--space-stack)]">
        <Card as="section" data-testid="deal-summary">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">{stageName}</span>
            <Badge tone={tone}>{t(`page.status.${deal.status}`)}</Badge>
            {deal.needsRebook && <Badge tone="warning">{t('page.needsRebook')}</Badge>}
            {deal.staleDays !== null && <Badge tone="warning">{t('page.stale', { days: deal.staleDays })}</Badge>}
          </div>
          <DataList items={summary} />
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
          <Card as="section" title={t('page.handoff')}>
            <p className="text-sm" data-testid="deal-handoff">
              {t(`page.handoffStatus.${view.handoff.status}`)}
            </p>
          </Card>
        )}

        <Card as="section" title={t('page.bookings')}>
          {view.bookings.length === 0 ? (
            <p className="text-sm text-[var(--text-2)]">{t('page.noBookings')}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {view.bookings.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2">
                  <span className="k-num">{t('page.bookingRow', { date: bookingDayLabel(b.bookingDate, locale), time: b.startTime })}</span>
                  <Badge tone={b.status === 'attended' ? 'success' : b.status === 'no_show' || b.status === 'cancelled' ? 'danger' : 'neutral'}>{t(`page.bookingStatus.${b.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section" title={t('page.history')}>
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
    </Page>
  );
});
