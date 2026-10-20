import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { BadRequestError, page } from '@/server/access';
import { CARD_STATES, listClients, parseListQuery, type ClientList } from '@/server/domain/clients';
import { Badge, Button, Chip, ChipGroup, EmptyState, Input, List, ListItem } from '@/ui/kit';
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

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-4 lg:py-6">
      <h1 className="mb-4 text-2xl font-semibold">{t('list.title')}</h1>
      <form method="get" action="/clients" role="search" className="mb-3 flex flex-col gap-2 sm:flex-row">
        {states.map((s) => (
          <input key={s} type="hidden" name="state" value={s} />
        ))}
        <Input name="q" type="search" defaultValue={q} placeholder={t('list.searchPlaceholder')} aria-label={t('list.search')} maxLength={100} className="sm:flex-1" />
        <Button type="submit" variant="primary">
          {t('list.searchSubmit')}
        </Button>
      </form>
      <p className="mb-3 text-sm text-[var(--text-2)]">{list.hint === 'short' ? t('list.shortQuery') : t('list.searchHint')}</p>
      <ChipGroup label={t('list.stateFilter')} className="mb-4">
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
        <div className="mt-4">
          <Button href={hrefWith(sp, (p) => p.set('cursor', list.next ?? ''))} variant="secondary">
            {t('list.more')}
          </Button>
        </div>
      )}
    </main>
  );
});
