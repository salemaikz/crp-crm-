// Закрытие приёма: второй рубеж в приложении и состояние «принимаем» (INTEGRATIONS 5.1, 5.2 п. 4, D-057, DEPLOY).
import { resolvers } from '@/server/access/context';
import { LOCKING_LICENSE_STATES } from '@/server/access/types';
import { readEnv, type Env } from '@/server/platform/env';

/**
 * Приём закрыт снаружи: `INGEST_PUBLIC` не равен `1`, а запрос пришёл через nginx (заголовок `X-Via-Proxy` ставит он на
 * все проксируемые запросы). Первый рубеж — сам nginx; этот работает, даже если конфигурация nginx ошибочна.
 * Внутренние источники ходят по сети Docker напрямую и заголовка не имеют. Fail closed: открывает только точное `1`.
 */
export function isClosedFromOutside(headers: { get(name: string): string | null }, env: Env = process.env): boolean {
  if (readEnv(env, 'INGEST_PUBLIC') === '1') return false;
  return headers.get('x-via-proxy') !== null;
}

/**
 * Принимаем ли лиды сейчас: лицензия не в `read_only`/`invalid`/`missing` и приём не выключен переключателем
 * `INGEST_ACCEPTING=0` (аварийный выключатель: источник держит запас у себя, получая 423).
 */
export async function isAccepting(env: Env = process.env): Promise<boolean> {
  if (readEnv(env, 'INGEST_ACCEPTING') === '0') return false;
  return !LOCKING_LICENSE_STATES.has(await resolvers().license());
}
