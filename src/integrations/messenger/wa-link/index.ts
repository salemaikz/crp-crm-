// messenger.wa_link (INTEGRATIONS §3.1): ссылка `wa.me` с номером и шаблоном. По умолчанию и запасной: посреднику
// ПДн не уходят, подключения, флага и лицензии нет. Ссылку строит чистая функция src/shared/whatsapp.ts.
import { z } from 'zod';
import { waHref } from '@/shared/whatsapp';
import type { MessengerPlugin } from '../../contract';

const empty = z.object({}).strict();
type Empty = z.infer<typeof empty>;

export const waLinkMessenger: MessengerPlugin<Empty, Empty> = {
  id: 'messenger.wa_link',
  kind: 'messenger',
  version: 1,
  crossBorder: false,
  needsConnection: false,
  configSchema: empty,
  secretsSchema: empty,
  capabilities: { chat: 'link', inbound: false, channels: false },
  healthCheck: async () => ({ ok: true, code: 'ok' }),
  openChat: async (_ctx, input) => {
    const href = waHref(input.chat.digits, input.text ?? '');
    return href ? { kind: 'link', href } : { kind: 'error', code: 'rejected' };
  },
};
