import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { pickLabel } from '@/server/domain/booking';
import { dealsDeps } from '@/server/domain/deals';
import { listHandoffs, type HandoffView } from '@/server/domain/handoffs';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Badge, EmptyState, List, ListItem, Page, PageHeader, Tabs } from '@/ui/kit';

// «Передачи» (B6b, §7.4): вкладки «Ждут» / «В работе» / «Закрытые». Охват — отношения главы отдела и исполнителя,
// роли РОП и директора; в строке нет суммы покупки и телефонов.
export default page<object, ReactNode>({ perm: 'handoff.read', target: 'section' }, async ({ viewer }) => {
  if (!isFeatureEnabled('PURCHASES')) notFound();
  const t = await getTranslations('handoffs');
  const locale = await getLocale();
  const deps = dealsDeps();
  const now = deps.now();
  const settings = viewer.spaceId ? await deps.settings(viewer.spaceId, now) : null;
  const tz = settings?.timeZone ?? 'UTC';
  const items = await listHandoffs(viewer, { statuses: ['pending', 'accepted', 'declined', 'cancelled'] });
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
  const serviceName = (key: string) => {
    const s = settings?.serviceTypes.find((x) => x.key === key);
    return s ? pickLabel(s.label, locale) : key;
  };

  const row = (h: HandoffView) => (
    <ListItem
      key={h.id}
      href={`/handoffs/${encodeURIComponent(h.id)}`}
      title={h.clientName}
      meta={
        <>
          <span>{serviceName(h.serviceTypeKey)}</span>
          {h.sellerName && <span>{` · ${t('seller')}: ${h.sellerName}`}</span>}
          <span>{` · ${t('assignee')}: ${h.assigneeName ?? t('noAssignee')}`}</span>
          {h.status === 'pending' && <span>{` · ${t('due', { time: dateFmt.format(new Date(h.dueAt)) })}`}</span>}
        </>
      }
      trailing={
        h.overdue ? <Badge tone="danger">{t('overdue')}</Badge> : <Badge tone={h.status === 'accepted' ? 'success' : h.status === 'pending' ? 'info' : 'neutral'}>{t(`status.${h.status}`)}</Badge>
      }
    />
  );
  const body = (list: HandoffView[]): ReactNode =>
    list.length === 0 ? <EmptyState framed={false} title={t('empty')} description={t('emptyHint')} /> : <List data-testid="handoff-list">{list.map(row)}</List>;
  const by = (...s: HandoffView['status'][]) => items.filter((h) => s.includes(h.status));

  return (
    <Page width="list">
      <PageHeader title={t('title')} />
      <Tabs
        label={t('tabs.label')}
        items={[
          { id: 'pending', label: t('tabs.pending'), count: by('pending').length, content: body(by('pending')) },
          { id: 'accepted', label: t('tabs.accepted'), count: by('accepted').length, content: body(by('accepted')) },
          { id: 'closed', label: t('tabs.closed'), count: by('declined', 'cancelled').length, content: body(by('declined', 'cancelled')) },
        ]}
      />
    </Page>
  );
});
