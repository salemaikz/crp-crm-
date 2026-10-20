// Действие кнопки «Позвонить» по режиму телефонии (D-268): `tel:` — ссылка звонилки телефона (manual и офлайн),
// `post` — звонок через провайдера (callback/originate, O7b). Единственное место интерфейса, где строится `tel:`.
import type { ChannelModes } from '@/integrations/contract';
import { telHref } from '@/shared/tel';

export type DialAction = { kind: 'tel'; href: string } | { kind: 'post' };

/** Пустой номер — `tel` с пустой ссылкой (кнопки нет). */
export function dialAction(phone: string, modes: ChannelModes, ext = ''): DialAction {
  if (modes.telephony.clickToCall !== 'tel') return { kind: 'post' };
  return { kind: 'tel', href: telHref(phone, ext) };
}
