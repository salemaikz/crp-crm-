'use client';

import { CalendarX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Alert, Button, Chip, ChipGroup, EmptyState } from '@/ui/kit';
import type { WizardChoice } from './choice';
import { formatChipDay } from './format';
import { fetchConsultStrip } from './result';
import type { ConsultStripDay, SuggestedConsultant } from './types';

interface Props {
  cardId: string;
  eventTypeKey: string;
  directionKey: string;
  /** Меняется после отказа сервера (место заняли): полоса перечитывается. */
  refreshKey: number;
  onPick: (choice: WizardChoice) => void;
}

// Чипы переносятся строками: на телефоне страница не прокручивается вбок
const WRAP = 'flex-wrap overflow-visible';

/**
 * Полоса подбора (B5b, за флагом BK_WIZARD): день → время → «Записать к <имя>» (второе нажатие — подтверждение
 * в ConfirmStep) или «Назначим утром», если пул вмещает «серую».
 */
export function ConsultPicker({ cardId, eventTypeKey, directionKey, refreshKey, onPick }: Props) {
  const t = useTranslations('booking.consult');
  const tw = useTranslations('booking.wizard');
  const locale = useLocale();
  const [days, setDays] = useState<ConsultStripDay[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Старая полоса остаётся на экране, пока приходит новая; смена направления пересоздаёт компонент (key в ConsultStep)
  useEffect(() => {
    let alive = true;
    void fetchConsultStrip(cardId, eventTypeKey, directionKey).then((next) => {
      if (!alive) return;
      if (next === null) return setFailed(true);
      setFailed(false);
      setDays(next);
      setTime(null);
      setDate((cur) => (cur !== null && next.some((d) => d.date === cur) ? cur : null));
    });
    return () => {
      alive = false;
    };
  }, [cardId, eventTypeKey, directionKey, refreshKey, attempt]);

  if (failed) {
    return (
      <Alert tone="warning">
        {t('loadFailed')}
        <Button variant="secondary" size="sm" className="ml-2" onClick={() => setAttempt((n) => n + 1)}>
          {t('retry')}
        </Button>
      </Alert>
    );
  }
  if (days === null) return <p className="text-sm text-[var(--text-2)]">{t('loading')}</p>;
  if (days.length === 0) return <EmptyState icon={<CalendarX />} title={tw('noSlots')} framed={false} headingLevel="h3" />;

  const day = days.find((d) => d.date === date);
  const slot = day?.slots.find((s) => s.time === time);
  const pickConsultant = (c: SuggestedConsultant) =>
    day && slot && onPick({ kind: 'individual', eventTypeKey, directionKey, date: day.date, time: slot.time, consultant: { resourceId: c.resourceId, name: c.name, reserve: c.reserve } });
  const greyHint = day?.greyTiming === 'next_run' ? t('greyNextRun') : day?.greyTiming === 'too_late' ? t('greyTooLate') : t('greyNextDay');

  return (
    <div className="flex flex-col gap-4">
      <ChipGroup label={tw('daysLabel')} className={WRAP}>
        {days.map((d) => (
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
        <ChipGroup label={tw('timesLabel')} className={WRAP}>
          {day.slots.map((s) => (
            <Chip key={s.time} active={time === s.time} onClick={() => setTime(s.time)}>
              {s.time}
            </Chip>
          ))}
        </ChipGroup>
      )}
      {day && slot && (
        <div className="flex flex-col gap-2" data-testid="consult-options">
          {slot.suggested && (
            <Button variant="primary" size="lg" block onClick={() => pickConsultant(slot.suggested as SuggestedConsultant)}>
              {t('suggested', { name: slot.suggested.name })}
              {slot.suggested.reserve ? ` · ${t('reserve')}` : ''}
            </Button>
          )}
          {slot.others.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-[var(--text-2)]">{t('others')}</span>
              <div className="flex flex-wrap gap-2">
                {slot.others.map((o) => (
                  <Button key={o.resourceId} variant="secondary" size="sm" onClick={() => pickConsultant(o)}>
                    {o.name}
                    {o.reserve ? ` · ${t('reserve')}` : ''}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {slot.greyAllowed && (
            <div className="flex flex-col gap-1">
              <Button
                variant={slot.suggested ? 'secondary' : 'primary'}
                size="lg"
                block
                onClick={() => onPick({ kind: 'individual', eventTypeKey, directionKey, date: day.date, time: slot.time })}
              >
                {t('grey')}
              </Button>
              <span className="text-sm text-[var(--text-2)]">{greyHint}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
