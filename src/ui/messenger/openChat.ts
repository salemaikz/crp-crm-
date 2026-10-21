// Действие кнопки «WhatsApp» по режиму мессенджера (D-268): `link` — wa.me с номером и шаблоном (по умолчанию и
// офлайн), `panel` — окно чата провайдера в карточке (O7a). Единственное место интерфейса, где строится wa.me.
import type { ChannelModes } from '@/integrations/contract';
import { waHref } from '@/shared/whatsapp';

export type ChatAction = { kind: 'link'; href: string } | { kind: 'panel' };

export function chatAction(phone: string, text: string, modes: ChannelModes): ChatAction {
  if (modes.messenger.chat !== 'link') return { kind: 'panel' };
  return { kind: 'link', href: waHref(phone, text) };
}
