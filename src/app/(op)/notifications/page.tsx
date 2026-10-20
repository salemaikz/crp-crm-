// Колокольчик: свои уведомления, новые сверху. Одна главная кнопка — «Прочитать все». Текст строится из локали по виду
// уведомления и числам в params (ПДн в записи нет). Один URL для всех ролей: оболочку выбирает RoleShell по роли.
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { page, type PageContext } from '@/server/access';
import { listMine } from '@/server/domain/notify';
import { Badge, Container, EmptyState, List, ListItem, PageHeader, buttonClass } from '@/ui/kit';
import { MarkAllRead } from './MarkAllRead';
import { hrefForKind, icuValues, isAlarmKind, isKnownKind } from './kinds';

type Props = { searchParams?: Promise<{ cursor?: string }> };

export default page<Props, React.ReactNode>({ perm: 'authenticated' }, async ({ viewer, props }: PageContext<Props>) => {
  const { cursor } = (await props.searchParams) ?? {};
  const [t, tk, fmt, data] = await Promise.all([
    getTranslations('notify'),
    getTranslations('notify.kinds'),
    getFormatter(),
    listMine(viewer, { cursor: cursor ?? null }),
  ]);
  return (
    <Container size="narrow" as="main">
      <PageHeader title={t('title')} lead={t('lead')} actions={data.unread > 0 ? <MarkAllRead /> : undefined} />
      {data.items.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.lead')} />
      ) : (
        <List aria-label={t('title')}>
          {data.items.map((n) => {
            const known = isKnownKind(n.kind);
            const href = hrefForKind(n.kind);
            return (
              <ListItem
                key={n.id}
                title={tk(known ? n.kind : 'unknown', icuValues(n.params))}
                meta={fmt.dateTime(n.createdAt, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: viewer.timeZone })}
                trailing={
                  n.readAt === null ? (
                    <Badge tone={isAlarmKind(n.kind) ? 'danger' : 'brand'}>{t(isAlarmKind(n.kind) ? 'badge.alarm' : 'badge.new')}</Badge>
                  ) : undefined
                }
                {...(href ? { href } : {})}
              />
            );
          })}
        </List>
      )}
      {data.next && (
        <p>
          <Link href={`/notifications?cursor=${data.next}`} className={buttonClass({ variant: 'quiet' })}>
            {t('more')}
          </Link>
        </p>
      )}
    </Container>
  );
});
