import { getTranslations } from 'next-intl/server';
import { Phone } from 'lucide-react';
import type { ChannelModes } from '@/integrations/contract';
import { Alert, Button } from '@/ui/kit';
import { dialAction } from '@/ui/call/dial';
import type { PhoneDto } from '@/server/domain/clients';
import { formatPhone } from './format';

/**
 * Главное действие карточки — одна кнопка «Позвонить» по режиму телефонии (`tel:` звонилки телефона или звонок
 * через провайдера). На телефоне закреплена внизу экрана с отступом под системную панель. Нет рабочего номера —
 * вместо кнопки пояснение.
 */
export async function CallButton({ phone, modes }: { phone: PhoneDto | null; modes: ChannelModes }) {
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
      <Button {...dialProps(phone, modes)} variant="primary" size="lg" block aria-label={t('call.aria', { phone: formatPhone(phone.e164) })}>
        <Phone aria-hidden="true" />
        {t('call.button')}
      </Button>
    </div>
  );
}

/** tel: — ссылка звонилки; звонок через провайдера (O7b) — кнопка без ссылки. */
function dialProps(phone: PhoneDto, modes: ChannelModes): { href?: string; external?: boolean } {
  const a = dialAction(phone.e164, modes, phone.ext);
  return a.kind === 'tel' ? { href: a.href, external: true } : {};
}
