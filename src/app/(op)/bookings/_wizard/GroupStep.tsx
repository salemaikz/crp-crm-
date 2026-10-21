'use client';

import { CalendarX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge, Button, EmptyState, List, ListItem } from '@/ui/kit';
import { formatWhen } from './format';
import type { BookingView, EventOption, OfferResult } from './types';

interface Props {
  offer: (OfferResult & { eventTypeKey: string }) | undefined;
  /** После «мест не осталось» сразу показываем остальные даты. */
  expanded: boolean;
  onPick: (event: EventOption) => void;
}

const place = (e: EventOption, online: string) => (e.format === 'online' ? online : e.location);

/** Групповой вид: ближайшее мероприятие с местами и одна главная кнопка; «Другая дата» открывает остальные. */
export function GroupStep({ offer, expanded, onPick }: Props) {
  const t = useTranslations('booking.wizard');
  const locale = useLocale();
  const [more, setMore] = useState(false);
  const current: BookingView | null = offer?.current ?? null;
  // Мероприятие, на которое клиент уже записан, не предлагаем
  const candidates = (offer?.options ?? []).filter((o) => o.id !== current?.eventId);
  const [nearest, ...rest] = candidates;
  const currentLine = current && <p className="text-sm text-[var(--text-2)]">{t('current', { when: formatWhen(current.bookingDate, current.startTime, locale) })}</p>;

  if (!nearest) return <>{currentLine}<EmptyState icon={<CalendarX />} title={t('noEvents')} framed={false} headingLevel="h3" /></>;

  const when = formatWhen(nearest.eventDate, nearest.startTime, locale);
  const where = place(nearest, t('online'));
  return (
    <div className="flex flex-col gap-3">
      {currentLine}
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--text-2)]">{t('nearest')}</p>
        <p className="text-lg font-semibold">{when}</p>
        {where && <p className="text-sm">{where}</p>}
        <div>
          <Badge tone={nearest.seats.left <= 3 ? 'warning' : 'info'}>{t('seatsLeft', { left: nearest.seats.left, capacity: nearest.seats.capacity })}</Badge>
        </div>
      </div>
      <Button variant="primary" size="lg" block onClick={() => onPick(nearest)}>
        {t(current ? 'moveOn' : 'bookOn', { when })}
      </Button>
      {rest.length > 0 && !more && !expanded && (
        <Button variant="secondary" block onClick={() => setMore(true)}>
          {t('otherDate')}
        </Button>
      )}
      {rest.length > 0 && (more || expanded) && (
        <List>
          {rest.map((o) => (
            <ListItem
              key={o.id}
              title={formatWhen(o.eventDate, o.startTime, locale)}
              meta={place(o, t('online')) || undefined}
              trailing={<Badge tone="info">{t('seatsLeft', { left: o.seats.left, capacity: o.seats.capacity })}</Badge>}
              onClick={() => onPick(o)}
            />
          ))}
        </List>
      )}
    </div>
  );
}
