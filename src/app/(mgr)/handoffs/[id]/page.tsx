import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { NotFoundError, page } from '@/server/access';
import { pickLabel } from '@/server/domain/booking';
import { dealsDeps } from '@/server/domain/deals';
import { getHandoff } from '@/server/domain/handoffs';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Badge, Button, Card, PageHeader } from '@/ui/kit';
import { HandoffActions } from '../_components/HandoffActions';

type Props = { params: Promise<{ id: string }> };

// Карточка передачи (B6b, §7.4): клиент, услуга, дата покупки, кнопки по правам. Маркетолог видит карточку
// без кнопок. Чужая и несуществующая — 404 одним ответом.
export default page<Props, ReactNode>({ perm: 'handoff.read', target: 'object' }, async ({ viewer, props }) => {
  if (!isFeatureEnabled('PURCHASES')) notFound();
  const { id } = await props.params;
  const t = await getTranslations('handoffs');
  const locale = await getLocale();
  let h;
  try {
    h = await getHandoff(viewer, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const deps = dealsDeps();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, deps.now()) : null;
  const tz = settings?.timeZone ?? 'UTC';
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
  const timeFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
  const service = settings?.serviceTypes.find((s) => s.key === h.serviceTypeKey);
  const live = h.status === 'pending' || h.status === 'accepted';

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-4">
      <PageHeader title={h.clientName} lead={t('page.title')} />
      <div className="flex flex-col gap-4">
        <Card as="section" data-testid="handoff-summary">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={h.overdue ? 'danger' : h.status === 'accepted' ? 'success' : h.status === 'pending' ? 'info' : 'neutral'}>
              {h.overdue ? t('overdue') : t(`status.${h.status}`)}
            </Badge>
            {h.status === 'pending' && <span className="text-sm">{t('due', { time: timeFmt.format(new Date(h.dueAt)) })}</span>}
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--text-2)]">{t('page.service')}</dt>
            <dd>{service ? pickLabel(service.label, locale) : h.serviceTypeKey}</dd>
            <dt className="text-[var(--text-2)]">{t('page.wonAt')}</dt>
            <dd>{h.wonAt !== null ? dateFmt.format(new Date(h.wonAt)) : ''}</dd>
            <dt className="text-[var(--text-2)]">{t('seller')}</dt>
            <dd>{h.sellerName ?? ''}</dd>
            <dt className="text-[var(--text-2)]">{t('assignee')}</dt>
            <dd data-testid="handoff-assignee">{h.assigneeName ?? t('noAssignee')}</dd>
            {h.declinedReason && (
              <>
                <dt className="text-[var(--text-2)]">{t('page.reason')}</dt>
                <dd>{h.declinedReason}</dd>
              </>
            )}
          </dl>
          {live && (
            <div className="mt-3">
              <Button href={`/clients/${encodeURIComponent(h.clientId)}`} variant="secondary" size="sm">
                {t('page.toClient')}
              </Button>
            </div>
          )}
        </Card>

        {live && <HandoffActions handoffId={h.id} can={h.can} />}

        <div className="flex flex-wrap gap-2">
          <Button href="/tasks" variant="secondary" size="sm">
            {t('page.toTasks')}
          </Button>
          <Button href="/handoffs" variant="secondary" size="sm">
            {t('page.back')}
          </Button>
        </div>
      </div>
    </main>
  );
});
