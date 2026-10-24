// Экран «Мои покупки» (pipeline-v2 §9.5): засчитанные сотруднику выигранные сделки по заслуге, итог месяца вверху.
// Название клиента показывается, только пока карточка в охвате (сервер присылает его или признак «клиент передан»).
// Вознаграждение CRM не считает: сумма сделки как есть.
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { formatKzt } from './money';
import { purchaseAmountLine, serviceLine, type ServiceLabels } from './purchase';
import { EmptyState, List, ListItem, Page, buttonClass } from '@/ui/kit';
import type { MyPurchases } from '@/server/domain/deals';

export function PurchasesScreen({ data, serviceLabels, timeZone }: { data: MyPurchases; serviceLabels: ServiceLabels; timeZone: string }) {
  const t = useTranslations('board');
  const f = useFormatter();
  const money = (n: number) => formatKzt(f, n);
  return (
    <Page width="list" data-testid="purchases-screen">
      <p className="mb-2 text-sm">
        <Link href="/board" className="underline" data-testid="purchases-back">
          {t('purchases.back')}
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold">{t('purchases.title')}</h1>
      <p className="mb-4 text-sm" style={{ color: 'var(--text-2)' }} data-testid="purchases-month-total">
        {t('purchases.summary', { count: data.month.count, sum: money(data.month.sumKzt) })}
      </p>
      {data.items.length === 0 ? (
        <EmptyState title={t('purchases.empty')} description={t('purchases.emptyHint')} />
      ) : (
        <List aria-label={t('purchases.list')} data-testid="purchases-list">
          {data.items.map((p) => (
            <ListItem
              key={p.dealId}
              title={p.clientName ?? t('purchases.transferred')}
              meta={
                <span className="flex flex-col" data-testid="purchase-meta">
                  <span data-testid="purchase-service">{serviceLine(p.serviceTypeKey, p.variant, serviceLabels) || (p.serviceTypeKey ? t('purchases.removed') : t('purchases.noType'))}</span>
                  <span className="whitespace-nowrap" data-testid="purchase-amount">
                    {purchaseAmountLine(p.amountKzt === null ? t('purchases.noAmount') : money(p.amountKzt), f.dateTime(p.wonAt, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }))}
                  </span>
                </span>
              }
              {...(p.clientId ? { href: `/clients/${p.clientId}` } : {})}
            />
          ))}
        </List>
      )}
      {data.next && (
        <p className="mt-3">
          <Link href={`/board/purchases?cursor=${encodeURIComponent(data.next)}`} className={buttonClass({ variant: 'quiet' })} data-testid="purchases-more">
            {t('purchases.more')}
          </Link>
        </p>
      )}
    </Page>
  );
}
