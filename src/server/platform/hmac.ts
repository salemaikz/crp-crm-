// HMAC номеров (стоп-лист, D-021) и ИИН (D-052): в БД только hex, открытое значение не хранится и не логируется.
// Ключи — CRM_PHONE_HMAC_KEY и CRM_IIN_HMAC_KEY из окружения; в production без ключа — исключение (fail closed).
// Единственная реализация: все пути создания клиента (ручной, импорт, приём) обязаны давать одинаковые хэши.
import { createHmac } from 'node:crypto';
import { isProduction, readEnv } from './env';

type EnvLike = Record<string, string | undefined>;

const DEV_PHONE_KEY = 'dev-only-phone-hmac-key';
const DEV_IIN_KEY = 'dev-only-iin-hmac-key';

function hmac(name: string, devKey: string, value: string, env: EnvLike): string {
  const key = readEnv(env, name);
  if (!key && isProduction(env)) throw new Error(`${name} is not set in production`);
  return createHmac('sha256', key ?? devKey).update(value).digest('hex');
}

/** HMAC номера в каноне `7XXXXXXXXXX`. */
export const phoneHmac = (digits: string, env: EnvLike = process.env): string => hmac('CRM_PHONE_HMAC_KEY', DEV_PHONE_KEY, digits, env);

/** HMAC ИИН (12 цифр). */
export const iinHmac = (digits: string, env: EnvLike = process.env): string => hmac('CRM_IIN_HMAC_KEY', DEV_IIN_KEY, digits, env);
