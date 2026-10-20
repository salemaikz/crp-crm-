'use client';

import { useTranslations } from 'next-intl';
import { Alert, Button, TextLink } from '@/ui/kit';

/** Запись сохранена: одна главная кнопка — вернуться к карточке клиента; «Записи» — ссылкой. */
export function DoneStep({ clientId, text }: { clientId: string; text: string }) {
  const t = useTranslations('booking.wizard');
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="success">{text}</Alert>
      <Button href={`/clients/${clientId}`} variant="primary" size="lg" block>
        {t('toClient')}
      </Button>
      <p className="text-center">
        <TextLink href="/bookings">{t('toBookings')}</TextLink>
      </p>
    </div>
  );
}
