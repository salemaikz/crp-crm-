import { getTranslations } from 'next-intl/server';
import { booking } from '@crm/core';
import type { BookingListItem } from '@/server/domain/booking';
import { Badge, List, ListItem } from '@/ui/kit';

const dayLabel = (date: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

/** Записи по дням: «15:00 · короткое имя вида · Клиент», бейдж статуса, у заявок без консультанта — отдельный бейдж. */
export async function BookingList({ items, today, locale, typeLabels }: { items: BookingListItem[]; today: string; locale: string; typeLabels: Record<string, string> }) {
  const t = await getTranslations('booking');
  const groups = new Map<string, BookingListItem[]>();
  for (const b of items) groups.set(b.bookingDate, [...(groups.get(b.bookingDate) ?? []), b]);
  const title = (date: string) => (date === today ? t('list.today') : date === booking.addDays(today, 1) ? t('list.tomorrow') : dayLabel(date, locale));
  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([date, rows]) => (
        <section key={date} aria-label={title(date)} className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-[var(--text-2)]">{title(date)}</h2>
          <List>
            {rows.map((b) => (
              <ListItem
                key={b.id}
                href={`/clients/${b.clientId}`}
                title={<><span className="k-num">{b.startTime}</span>{` · ${typeLabels[b.eventTypeKey] ?? b.eventTypeKey} · ${b.clientName}`}</>}
                trailing={
                  <span className="flex flex-col items-end gap-1">
                    <Badge tone={b.status === 'confirmed' ? 'success' : 'info'}>{t(`status.${b.status}`)}</Badge>
                    {b.grey && <Badge tone="warning">{t('list.grey')}</Badge>}
                  </span>
                }
              />
            ))}
          </List>
        </section>
      ))}
    </div>
  );
}
