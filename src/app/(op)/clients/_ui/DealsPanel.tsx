'use client';

import { useTranslations } from 'next-intl';
import { Badge, Button, Card, EmptyState } from '@/ui/kit';
import { useFeedControl } from './ClientsProviders';
import { formatDate, formatNumber, labelOf } from './format';
import type { CatalogView, DealView } from './types';

type Props = { deals: DealView[]; catalog: CatalogView; timeZone: string };

const TONE = { open: 'neutral', won: 'success', lost: 'danger' } as const;

/** История сделок клиента. «История» у сделки сужает ленту до её событий (повторное нажатие снимает). */
export function DealsPanel({ deals, catalog, timeZone }: Props) {
  const t = useTranslations('clients');
  const control = useFeedControl();
  return (
    <Card as="section" aria-labelledby="client-deals-title">
      <h2 id="client-deals-title" className="mb-2 text-lg font-semibold">
        {t('deals.title')}
      </h2>
      {deals.length === 0 ? (
        <EmptyState framed={false} headingLevel="h3" title={t('deals.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border)]">
          {deals.map((d) => {
            const stage = catalog.stages[`${d.pipelineKey}:${d.stageKey}`];
            const service = catalog.serviceTypes[d.serviceTypeKey];
            const active = control.dealId === d.id;
            const date = d.wonAt ?? d.lostAt ?? d.createdAt;
            return (
              <li key={d.id} className="flex flex-col gap-1 py-2" data-testid="deal-row">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[d.status]}>{t(`deals.status.${d.status}`)}</Badge>
                  <span className="font-medium">{stage ? labelOf(stage) : d.stageKey}</span>
                  {service && <span>{labelOf(service)}</span>}
                  {d.amountKzt !== null && d.amountKzt > 0 && <span>{formatNumber(d.amountKzt)} ₸</span>}
                </div>
                <p className="text-sm text-[var(--text-2)]">
                  {formatDate(date, timeZone)}
                  {d.ownerName ? ` · ${d.ownerName}` : ''}
                </p>
                <div>
                  <Button variant={active ? 'secondary' : 'quiet'} size="sm" aria-pressed={active} onClick={() => control.setDealId(active ? null : d.id)}>
                    {active ? t('deals.historyOff') : t('deals.history')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
