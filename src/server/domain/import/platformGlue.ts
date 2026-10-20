// Мелкая связка с платформой, которой пока нет в платформе (дизайн C4d §17 п. 2): блокировка применения,
// флаг FEATURE_IMPORT и HMAC ИИН. Когда platform заведёт IMPORT_APPLY_LOCK_KEY в db/locks.ts, 'IMPORT' в
// FEATURES и iinHmac в platform/hmac.ts (общий с C3 и K2), этот файл удаляется, а импорты заменяются.
import { createHmac } from 'node:crypto';
import { isDevOrTest, isProduction, readEnv, type Env } from '@/server/platform/env';
export { INTAKE_LOCK_KEY } from '@/server/platform/db/locks';
export { phoneHmac } from '@/server/platform/hmac';

/** Одновременно применяется один импорт на установку (D-113). */
export const IMPORT_APPLY_LOCK_KEY = 72_026_102_011;

/**
 * FEATURE_IMPORT (D-116): '1' — вкл, '0' — выкл; не задан — включён только в development и test, как
 * остальные флаги модулей (platform/flags.ts). Любое другое значение — выключен (fail closed).
 */
export function importEnabled(env: Env = process.env): boolean {
  const raw = env.FEATURE_IMPORT?.trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  if (raw === undefined || raw === '') return isDevOrTest(env);
  return false;
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
