'use client';

// Мастер записи внутри шторки итога (D-202, booking-wizard-design §2, путь A): вид мастера читается с сервера,
// отправку записи делает шторка вместе с итогом. Нет сети — мастер не открывается, остаётся «Запишу позже».
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { BookingWizard, type BookingWizardProps } from '@/app/(op)/bookings/_wizard/BookingWizard';
import { fetchWizard } from '@/app/(op)/bookings/_wizard/result';
import type { BookingWizardView } from '@/app/(op)/bookings/_wizard/types';
import { Alert, Button } from '@/ui/kit';

type Props = {
  cardId: string;
  submit: NonNullable<BookingWizardProps['submit']>;
  onDone: NonNullable<BookingWizardProps['onDone']>;
  onBack: () => void;
  onLater: () => void;
};

export function BookingPanel({ cardId, submit, onDone, onBack, onLater }: Props) {
  const t = useTranslations('call');
  const [view, setView] = useState<BookingWizardView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchWizard(cardId).then((v) => {
      if (!alive) return;
      if (v) setView(v);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [cardId, attempt]);

  const retry = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="booking-panel">
      {!view && !failed && (
        <p role="status" style={{ color: 'var(--text-2)' }}>
          {t('booking.loading')}
        </p>
      )}
      {failed && (
        <Alert tone="warning" title={t('booking.unavailableTitle')}>
          {t('booking.unavailableText')}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={retry}>
              {t('booking.retry')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onLater} data-testid="booking-later">
              {t('sheet.later')}
            </Button>
          </div>
        </Alert>
      )}
      {/* Состояние карточки в этот момент ещё «рабочее»: запись разрешает сам итог, поэтому мастер всегда в режиме direct */}
      {view && <BookingWizard view={{ ...view, mode: 'direct' }} submit={submit} onDone={onDone} />}
      <Button variant="quiet" block onClick={onBack} data-testid="booking-back">
        {t('sheet.back')}
      </Button>
    </div>
  );
}
