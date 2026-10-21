'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/ui/kit';
import type { WizardChoice } from './choice';
import { formatWhen } from './format';
import type { BookingView, WizardEventType } from './types';

interface Props {
  clientName: string;
  type: WizardEventType | undefined;
  choice: WizardChoice;
  current: BookingView | null;
  directionLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

/** Подтверждение на месте (не вторая модалка): вопрос, «Подтвердить» — главная, «Назад» — тихая. */
export function ConfirmStep({ clientName, type, choice, current, directionLabel, busy, onConfirm, onBack }: Props) {
  const t = useTranslations('booking.wizard');
  const tc = useTranslations('booking.consult');
  const locale = useLocale();
  const to = choice.kind === 'group' ? formatWhen(choice.event.eventDate, choice.event.startTime, locale) : formatWhen(choice.date, choice.time, locale);
  const from = current ? formatWhen(current.bookingDate, current.startTime, locale) : '';
  const typeLabel = type?.short ?? choice.eventTypeKey;
  const consultant = choice.kind === 'individual' ? choice.consultant : undefined;
  const text = consultant
    ? current
      ? tc('confirmMove', { client: clientName, from, to, consultant: consultant.name })
      : tc(consultant.reserve ? 'confirmReserve' : 'confirm', { client: clientName, type: typeLabel, when: to, consultant: consultant.name })
    : choice.kind === 'group'
      ? current
        ? t('confirmMove', { client: clientName, from, to })
        : t('confirmBook', { client: clientName, type: typeLabel, when: to })
      : current
        ? t('confirmRequestMove', { client: clientName, from, to, direction: directionLabel })
        : t('confirmRequest', { client: clientName, type: typeLabel, when: to, direction: directionLabel });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base">{text}</p>
      <Button variant="primary" size="lg" block disabled={busy} onClick={onConfirm}>
        {t('confirm')}
      </Button>
      <Button variant="quiet" disabled={busy} onClick={onBack}>
        {t('back')}
      </Button>
    </div>
  );
}
