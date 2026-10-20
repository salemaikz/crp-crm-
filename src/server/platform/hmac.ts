// HMAC номера для стоп-листа (D-021): в БД лежит только hex, открытый номер туда не попадает.
// Ключ — CRM_PHONE_HMAC_KEY из окружения; в production без ключа — исключение (fail closed).
import { createHmac } from 'node:crypto';
import { isProduction, readEnv } from './env';

const DEV_KEY = 'dev-only-phone-hmac-key';

export function phoneHmac(digits: string, env: Record<string, string | undefined> = process.env): string {
  const key = readEnv(env, 'CRM_PHONE_HMAC_KEY');
  if (!key && isProduction(env)) throw new Error('CRM_PHONE_HMAC_KEY is not set in production');
  return createHmac('sha256', key ?? DEV_KEY).update(digits).digest('hex');
}
