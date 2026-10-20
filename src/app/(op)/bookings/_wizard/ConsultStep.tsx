'use client';

import { CalendarX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, Chip, ChipGroup, EmptyState } from '@/ui/kit';
import type { WizardChoice } from './choice';
import { formatChipDay, formatWhen } from './format';
import type { ConsultOffer } from './types';

interface Props {
  offer: ConsultOffer | undefined;
  onPick: (choice: WizardChoice) => void;
}

// Чипы переносятся строками: на телефоне страница не прокручивается вбок
const WRAP = 'flex-wrap overflow-visible';

/** Индивидуальный вид: направление → день → время → заявка без консультанта (его назначит руководитель). */
export function ConsultStep({ offer, onPick }: Props) {
  const t = useTranslations('booking.wizard');
  const locale = useLocale();
  const [direction, setDirection] = useState<string | null>(offer?.directions.length === 1 ? (offer.directions[0]?.key ?? null) : null);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);

  if (!offer || offer.days.length === 0) return <EmptyState icon={<CalendarX />} title={t('noSlots')} framed={false} headingLevel="h3" />;

  const day = offer.days.find((d) => d.date === date);
  const ready = direction !== null && day !== undefined && time !== null && day.times.includes(time);
  const when = ready ? formatWhen(day.date, time, locale) : '';
  return (
    <div className="flex flex-col gap-4">
      {offer.current && <p className="text-sm text-[var(--text-2)]">{t('current', { when: formatWhen(offer.current.bookingDate, offer.current.startTime, locale) })}</p>}
      <ChipGroup label={t('directionsLabel')} className={WRAP}>
        {offer.directions.map((d) => (
          <Chip key={d.key} active={direction === d.key} onClick={() => setDirection(d.key)}>
            {d.label}
          </Chip>
        ))}
      </ChipGroup>
      <ChipGroup label={t('daysLabel')} className={WRAP}>
        {offer.days.map((d) => (
          <Chip
            key={d.date}
            active={date === d.date}
            onClick={() => {
              setDate(d.date);
              setTime(null);
            }}
          >
            {formatChipDay(d.date, locale)}
          </Chip>
        ))}
      </ChipGroup>
      {day && (
        <ChipGroup label={t('timesLabel')} className={WRAP}>
          {day.times.map((x) => (
            <Chip key={x} active={time === x} onClick={() => setTime(x)}>
              {x}
            </Chip>
          ))}
        </ChipGroup>
      )}
      <p className="text-sm">
        <span className="text-[var(--text-2)]">{t('consultant')}: </span>
        {t('noConsultant')}
      </p>
      <Button
        variant="primary"
        size="lg"
        block
        disabled={!ready}
        onClick={() => ready && onPick({ kind: 'individual', eventTypeKey: offer.eventTypeKey, directionKey: direction, date: day.date, time })}
      >
        {ready ? t(offer.current ? 'moveOn' : 'requestOn', { when }) : t('requestOn', { when: '…' })}
      </Button>
    </div>
  );
}
