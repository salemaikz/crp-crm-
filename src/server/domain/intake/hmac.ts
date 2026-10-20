// HMAC номеров (стоп-лист, D-021) и ИИН (D-052): в БД только hex, открытое значение не хранится и не логируется.
// Ключи — CRM_PHONE_HMAC_KEY и CRM_IIN_HMAC_KEY из окружения; в production без ключа — исключение (fail closed).
// Для номеров та же функция, что у остальных путей создания клиента: хэши стоп-листа должны совпадать.
import { createHmac } from 'node:crypto';
import { isProduction, readEnv, type Env } from '@/server/platform/env';

const DEV_PHONE_KEY = 'dev-only-phone-hmac-key';
const DEV_IIN_KEY = 'dev-only-iin-hmac-key';

function hmac(name: string, devKey: string, value: string, env: Env): string {
  const key = readEnv(env, name);
  if (!key && isProduction(env)) throw new Error(`${name} is not set in production`);
  return createHmac('sha256', key ?? devKey).update(value).digest('hex');
}

/** HMAC номера в каноне `7XXXXXXXXXX`. */
export const phoneHmac = (digits: string, env: Env = process.env): string => hmac('CRM_PHONE_HMAC_KEY', DEV_PHONE_KEY, digits, env);

/** HMAC ИИН (12 цифр). */
export const iinHmac = (digits: string, env: Env = process.env): string => hmac('CRM_IIN_HMAC_KEY', DEV_IIN_KEY, digits, env);
