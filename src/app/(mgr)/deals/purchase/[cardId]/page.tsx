import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { NotFoundError, page } from '@/server/access';
import { pickLabel } from '@/server/domain/booking';
import { dealsDeps, getPurchaseForm } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Alert, Button, Card, Page, PageHeader } from '@/ui/kit';
import { PurchaseForm } from '../../_components/PurchaseForm';

type Props = { params: Promise<{ cardId: string }> };

// Форма покупки по карточке (B6, §5.9): сделка, услуга, сумма в целых тенге, дата. Чужая карточка — 404.
export default page<Props, ReactNode>({ perm: 'deal.purchase', target: 'object' }, async ({ viewer, props }) => {
  if (!isFeatureEnabled('PURCHASES')) notFound();
  const { cardId } = await props.params;
  const locale = await getLocale();
  const t = await getTranslations('deals');
  const deps = dealsDeps();
  let form;
  try {
    form = await getPurchaseForm(deps, viewer, { cardId, locale });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const stageLabel = (key: string): string => {
    for (const p of settings?.pipelines ?? []) {
      const s = p.stages.find((x) => x.key === key);
      if (s) return pickLabel(s.label, locale);
    }
    return key;
  };
  return (
    <Page width="form">
      <PageHeader title={t('purchase.title')} lead={form.clientName} />
      {form.allowed ? (
        <PurchaseForm
          cardId={form.cardId}
          deals={form.openDeals.map((d) => ({ id: d.id, label: stageLabel(d.stageKey) }))}
          defaultDealId={form.defaultDealId}
          services={form.serviceTypes}
          today={form.today}
        />
      ) : (
        <Card as="section">
          <Alert tone="warning">{t('outcomeFirst')}</Alert>
          <div className="mt-3">
            <Button href={`/clients/${encodeURIComponent(form.clientId)}`} variant="secondary">
              {t('page.toClient')}
            </Button>
          </div>
        </Card>
      )}
    </Page>
  );
});
