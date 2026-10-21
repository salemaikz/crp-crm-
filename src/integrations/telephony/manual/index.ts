// telephony.manual (INTEGRATIONS §2.2): обычная звонилка телефона по ссылке `tel:`. Режим по умолчанию и запасной:
// без подключения, флага и лицензии. Ссылку строит чистая функция src/shared/tel.ts — та же, что офлайн на устройстве.
import { z } from 'zod';
import { telHref } from '@/shared/tel';
import type { TelephonyPlugin } from '../../contract';

const empty = z.object({}).strict();
type Empty = z.infer<typeof empty>;

export const manualTelephony: TelephonyPlugin<Empty, Empty> = {
  id: 'telephony.manual',
  kind: 'telephony',
  version: 1,
  crossBorder: false,
  needsConnection: false,
  configSchema: empty,
  secretsSchema: empty,
  capabilities: { clickToCall: 'tel', clientFirst: false, webhooks: false, recordings: 'none', listCalls: false, returnsCallIdOnInitiate: false },
  healthCheck: async () => ({ ok: true, code: 'ok' }),
  initiateCall: async (_ctx, input) => {
    const href = telHref(input.clientDigits, input.ext ?? '');
    return href ? { kind: 'tel', href } : { kind: 'error', code: 'bad_number' };
  },
};
