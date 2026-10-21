// Мелкая связка с платформой (дизайн C4d §17 п. 2): флаг FEATURE_IMPORT и HMAC ИИН. Ключ блокировки применения
// живёт в db/locks.ts, флаг 'IMPORT' заведён в platform/flags.ts. Когда iinHmac переедет в platform/hmac.ts
// (общий с C3 и K2), а importEnabled заменится на isFeatureEnabled, этот файл удаляется.
import { createHmac } from 'node:crypto';
import { isProduction, readEnv, type Env } from '@/server/platform/env';
import { isFeatureEnabled } from '@/server/platform/flags';
import { vercelStandActive } from '@/server/platform/stand';
export { IMPORT_APPLY_LOCK_KEY, INTAKE_LOCK_KEY } from '@/server/platform/db/locks';
export { phoneHmac } from '@/server/platform/hmac';

/**
 * FEATURE_IMPORT (D-116): '1' — вкл, '0' — выкл; не задан — включён только в development и test, как
 * остальные флаги модулей (platform/flags.ts). Любое другое значение — выключен (fail closed).
 */
export function importEnabled(env: Env = process.env): boolean {
  return isFeatureEnabled('IMPORT', env);
}

/**
 * Тестовый стенд на Vercel (D-318): загрузка файлов закрыта при любом FEATURE_IMPORT. Импорт — главный путь, которым
 * настоящие таблицы клиентов попали бы на сервер вне РК (D-008); на стенде данные — только синтетика сида.
 */
export function standImportBlocked(env: Env = process.env): boolean {
  return vercelStandActive(env);
}

const DEV_IIN_KEY = 'dev-only-iin-hmac-key';

/** HMAC ИИН (12 цифр), ключ CRM_IIN_HMAC_KEY; в production без ключа — исключение. Совпадает с хэшем приёма. */
export function iinHmac(digits: string, env: Env = process.env): string {
  const key = readEnv(env, 'CRM_IIN_HMAC_KEY');
  if (!key && isProduction(env)) throw new Error('CRM_IIN_HMAC_KEY is not set in production');
  return createHmac('sha256', key ?? DEV_IIN_KEY).update(digits).digest('hex');
}

/** Идентификатор сборки для отпечатка предпросмотра: CRM_BUILD_ID или 'dev'. */
export function buildId(env: Env = process.env): string {
  return readEnv(env, 'CRM_BUILD_ID') ?? 'dev';
}
