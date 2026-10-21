import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { BadRequestError, page } from '@/server/access';
import { archiveReasonLabels } from '@/server/domain/cards';
import { listClients, parseListQuery, type ClientList } from '@/server/domain/clients';
import { Badge, Button, EmptyState, List, ListItem, Page } from '@/ui/kit';
import { formatDate, formatPhone } from '../clients/_ui/format';
import { stateTone } from '../clients/_ui/stateTone';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// Архив закрытых карточек (PROCESS 2.9): оператор видит свой, РОП — весь. Охват — тот же, что у списка клиентов.
export default page<Props, ReactNode>({ perm: 'client.read', target: 'section' }, async ({ viewer, props }) => {
  const t = await getTranslations('clients');
  const raw = await props.searchParams;
  const sp = new URLSearchParams();
  const cursor = typeof raw.cursor === 'string' ? raw.cursor : null;
  const owner = typeof raw.owner === 'string' ? raw.owner : null;
  sp.set('view', 'archive');
  if (cursor) sp.set('cursor', cursor);
  if (owner) sp.set('owner', owner);
  let list: ClientList;
  try {
    list = await listClients(viewer, parseListQuery(sp));
  } catch (e) {
    if (!(e instanceof BadRequestError)) throw e;
    list = { items: [], next: null };
  }
  const reasons = await archiveReasonLabels(viewer);
  const tz = viewer.timeZone;
  return (
    <Page width="list">
      <h1 className="mb-1 text-2xl font-semibold">{t('archive.title')}</h1>
      <p className="mb-4 text-sm text-[var(--text-2)]">{t('archive.lead')}</p>
      {list.items.length === 0 ? (
        <EmptyState title={t('archive.emptyTitle')} description={t('archive.emptyText')} />
      ) : (
        <List>
          {list.items.map((c) => (
            <ListItem
              key={c.id}
              href={`/clients/${c.id}`}
              title={c.name}
              meta={[
                c.primaryPhone ? formatPhone(c.primaryPhone) : t('list.noPhone'),
                reasons[c.state]?.[c.closeReasonCode] ?? t('archive.noReason'),
                c.closedAt !== null ? t('archive.closed', { date: formatDate(c.closedAt, tz) }) : null,
                c.state === 'not_interested' && c.returnAt !== null ? t('archive.returnAt', { date: formatDate(c.returnAt, tz) }) : null,
              ]
                .filter((x): x is string => x !== null)
                .join(' · ')}
              trailing={<Badge tone={stateTone(c.state)}>{t(`states.${c.state}`)}</Badge>}
            />
          ))}
        </List>
      )}
      {list.next && (
        <div className="mt-4">
          <Button href={`/archive?${new URLSearchParams({ ...(owner ? { owner } : {}), cursor: list.next }).toString()}`} variant="secondary">
            {t('list.more')}
          </Button>
        </div>
      )}
    </Page>
  );
});
