import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { BadRequestError, page } from '@/server/access';
import { CARD_STATES, listClients, parseListQuery, type ClientList } from '@/server/domain/clients';
import { Search } from 'lucide-react';
import { Badge, Button, Chip, ChipGroup, EmptyState, Input, List, ListItem, Page, PageHeader, Segmented } from '@/ui/kit';
import { can } from '@/server/access';
import { ProposeSheet } from './_ui/ProposeSheet';
import { formatDateTime, formatPhone } from './_ui/format';
import { stateTone } from './_ui/stateTone';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function toParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else if (v !== undefined) sp.set(k, v);
  }
  return sp;
}

/** Ссылка списка с изменённым запросом: поиск и состояния сохраняются, курсор сбрасывается. */
function hrefWith(sp: URLSearchParams, change: (p: URLSearchParams) => void): string {
  const p = new URLSearchParams(sp);
  p.delete('cursor');
  change(p);
  const s = p.toString();
  return s ? `/clients?${s}` : '/clients';
}

// Список клиентов: поиск (название, БИН, номер), фильтр по состоянию, строки с главным номером.
export default page<Props, ReactNode>({ perm: 'client.read', target: 'section' }, async ({ viewer, props }) => {
  const t = await getTranslations('clients');
  const sp = toParams(await props.searchParams);
  let list: ClientList;
  let broken = false;
  try {
    list = await listClients(viewer, parseListQuery(sp));
  } catch (e) {
    // Мусор в адресной строке — пустой список с подсказкой, а не ошибка страницы
    if (!(e instanceof BadRequestError)) throw e;
    list = { items: [], next: null };
    broken = true;
  }
  const states = sp.getAll('state');
  const q = sp.get('q') ?? '';
  const view = sp.get('view') === 'mine' ? 'mine' : 'all';

  return (
    <Page width="list">
      <PageHeader
        title={t('list.title')}
        actions={can(viewer, 'client.propose') ? <ProposeSheet /> : undefined}
        tabs={
          <Segmented
            label={t('list.view')}
            items={[
              { id: 'all', label: t('list.viewAll'), href: hrefWith(sp, (p) => p.delete('view')), active: view === 'all' },
              { id: 'mine', label: t('list.viewMine'), href: hrefWith(sp, (p) => p.set('view', 'mine')), active: view === 'mine' },
              { id: 'archive', label: t('list.viewArchive'), href: '/archive' },
            ]}
          />
        }
      />
      <form method="get" action="/clients" role="search" className="flex flex-col gap-1">
        {states.map((s) => (
          <input key={s} type="hidden" name="state" value={s} />
        ))}
        {view === 'mine' && <input type="hidden" name="view" value="mine" />}
        {/* Поиск — поле со значком отправки внутри (Enter тоже отправляет), без второй полноширинной кнопки */}
        <div className="k-input-group">
          <Input name="q" type="search" defaultValue={q} placeholder={t('list.searchPlaceholder')} aria-label={t('list.search')} maxLength={100} />
          <button type="submit" className="k-input-group__btn" aria-label={t('list.searchSubmit')}>
            <Search aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm text-[var(--text-2)]">{list.hint === 'short' ? t('list.shortQuery') : t('list.searchHint')}</p>
      </form>
      <ChipGroup label={t('list.stateFilter')}>
        <Chip href={hrefWith(sp, (p) => p.delete('state'))} active={states.length === 0}>
          {t('list.stateAll')}
        </Chip>
        {CARD_STATES.map((s) => (
          <Chip
            key={s}
            href={hrefWith(sp, (p) => {
              p.delete('state');
              if (!states.includes(s)) p.append('state', s);
            })}
            active={states.includes(s)}
          >
            {t(`states.${s}`)}
          </Chip>
        ))}
      </ChipGroup>
      {list.items.length === 0 ? (
        <EmptyState title={broken ? t('list.brokenTitle') : t('list.emptyTitle')} description={broken ? t('list.brokenText') : t('list.emptyText')} />
      ) : (
        <List>
          {list.items.map((c) => (
            <ListItem
              key={c.id}
              href={`/clients/${c.id}`}
              title={c.name}
              meta={[
                c.primaryPhone ? formatPhone(c.primaryPhone) : t('list.noPhone'),
                c.lastTouchAt !== null ? t('list.touch', { date: formatDateTime(c.lastTouchAt, viewer.timeZone) }) : t('list.noTouch'),
              ].join(' · ')}
              trailing={<Badge tone={stateTone(c.state)}>{t(`states.${c.state}`)}</Badge>}
            />
          ))}
        </List>
      )}
      {list.next && (
        <div>
          <Button href={hrefWith(sp, (p) => p.set('cursor', list.next ?? ''))} variant="secondary">
            {t('list.more')}
          </Button>
        </div>
      )}
    </Page>
  );
});
