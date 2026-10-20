// telephony.beeline — заготовка (INTEGRATIONS §2.3, дизайн §7.8): адаптер пишется после документации Beeline.
// Без API: healthCheck → not_configured, звонок → no_endpoint, вебхуков нет. За FEATURE_TELEPHONY_BEELINE и
// признаком лицензии telephony.beeline; данные остаются в РК (crossBorder: false).
import { z } from 'zod';
import type { TelephonyPlugin } from '../../contract';

const empty = z.object({}).strict();
type Empty = z.infer<typeof empty>;

export const beelineTelephony: TelephonyPlugin<Empty, Empty> = {
  id: 'telephony.beeline',
  kind: 'telephony',
  version: 1,
  flag: 'TELEPHONY_BEELINE',
  licenseFeature: 'telephony.beeline',
  crossBorder: false,
  needsConnection: true,
  configSchema: empty,
  secretsSchema: empty,
  // Возможности уточнятся по документации провайдера (INTEGRATIONS §2.3 п. 1)
  capabilities: { clickToCall: 'callback', clientFirst: false, webhooks: false, recordings: 'none', listCalls: false, returnsCallIdOnInitiate: false },
  healthCheck: async () => ({ ok: false, code: 'not_configured' }),
  initiateCall: async () => ({ kind: 'error', code: 'no_endpoint' }),
};
