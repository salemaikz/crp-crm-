import { getTranslations } from 'next-intl/server';
import { Phone } from 'lucide-react';
import { Alert, Button } from '@/ui/kit';
import type { PhoneDto } from '@/server/domain/clients';
import { formatPhone, telHref } from './format';

/**
 * Главное действие карточки — одна кнопка «Позвонить» (`tel:`). На телефоне закреплена внизу экрана
 * с отступом под системную панель. Нет рабочего номера — вместо кнопки пояснение.
 */
export async function CallButton({ phone }: { phone: PhoneDto | null }) {
  const t = await getTranslations('clients');
  if (!phone) {
    return (
      <Alert tone="warning" title={t('call.noPhoneTitle')}>
        {t('call.noPhoneText')}
      </Alert>
    );
  }
  return (
    <div className="sticky bottom-0 z-10 -mx-4 bg-[var(--canvas)] px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] lg:static lg:mx-0 lg:bg-transparent lg:p-0">
      <Button href={telHref(phone.e164, phone.ext)} external variant="primary" size="lg" block aria-label={t('call.aria', { phone: formatPhone(phone.e164) })}>
        <Phone aria-hidden="true" />
        {t('call.button')}
      </Button>
    </div>
  );
}
