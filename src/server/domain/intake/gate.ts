// Закрытие приёма: второй рубеж в приложении и состояние «принимаем» (INTEGRATIONS 5.1, 5.2 п. 4, D-057, DEPLOY).
import { resolvers } from '@/server/access/context';
import { LOCKING_LICENSE_STATES } from '@/server/access/types';
import { readEnv, type Env } from '@/server/platform/env';
import { ingestReachable } from '@/server/platform/http/trustedProxy';

/**
 * Приём закрыт снаружи (второй рубеж, D-155): через nginx запрос несёт верный `X-Proxy-Secret` и проходит
 * только при `INGEST_PUBLIC=1`; запрос с меткой прокси без верного секрета — подделка и закрыт всегда.
 * Внутренние источники ходят по сети Docker напрямую, без меток. Первый рубеж — сам nginx.
 */
export function isClosedFromOutside(headers: { get(name: string): string | null }, env: Env = process.env): boolean {
  return !ingestReachable(headers, env);
}

/**
 * Принимаем ли лиды сейчас: лицензия не в `read_only`/`invalid`/`missing` и приём не выключен переключателем
 * `INGEST_ACCEPTING=0` (аварийный выключатель: источник держит запас у себя, получая 423).
 */
export async function isAccepting(env: Env = process.env): Promise<boolean> {
  if (readEnv(env, 'INGEST_ACCEPTING') === '0') return false;
  return !LOCKING_LICENSE_STATES.has(await resolvers().license());
}
