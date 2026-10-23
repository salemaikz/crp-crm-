// Режим стенда на Vercel (D-318, docs/ops/VERCEL.md): чем дополняется окружение. Чистые функции от окружения и
// водяного знака — их проверяют тесты; применяет их index.ts (хук старта Next) и scripts/vercel/stand-env.ts (сборка).
// Режим только для тестового стенда на синтетике: в нём нет nginx и CRM_PROXY_SECRET, адрес — домен проекта Vercel,
// секреты выводятся из одной переменной CRM_DEMO_SECRET. Явно заданные переменные не перезаписываются никогда,
// кроме флагов интеграций (на стенде Vercel выключены всегда) и каталога ассетов CRM_ASSETS_DIR (всегда stand-assets).
import { hkdfSync } from 'node:crypto';
import { standDefaultOrigin, standRequested } from './origin';

type Env = Record<string, string | undefined>;

const has = (e: Env, name: string): boolean => (e[name]?.trim() ?? '') !== '';

/** Что сборка знает о себе: клиент из водяного знака ядра (null — общая) и признак сборки стенда (vercel-build). */
export type StandBuild = { customer: string | null; standBuild: boolean };

/** Режим стенда на Vercel: VERCEL=1, CRM_STAND=1, общая сборка (без водяного знака клиента) с признаком стенда. */
export function isVercelStand(e: Env, build: StandBuild): boolean {
  return standRequested(e) && build.customer === null && build.standBuild;
}

/** Номера стенда — только служебный блок +7 709 (канон 7709…): настоящие номера на стенд не попадают (D-008). */
export const STAND_PHONE_PREFIX = '7709';

/** Главный секрет стенда: от 32 символов (генератор: `openssl rand -base64 48`). */
export const DEMO_SECRET_ENV = 'CRM_DEMO_SECRET';
export const DEMO_SECRET_MIN = 32;

/** Секреты, без которых production не работает, и метки HKDF для их вывода (метка меняется — меняется ключ). */
export const DERIVED_SECRETS: Readonly<Record<string, string>> = Object.freeze({
  CRM_PHONE_HMAC_KEY: 'crm/vercel-stand/v1/phone-hmac',
  CRM_IIN_HMAC_KEY: 'crm/vercel-stand/v1/iin-hmac',
});
/** Ключ шифрования секретов интеграций (D-269): kid и метка; выводится, только если ни одного ключа не задано. */
export const STAND_SECRETS_KID = 'stand';
const SECRETS_KEY_LABEL = 'crm/vercel-stand/v1/integration-secrets';
const HKDF_SALT = 'crm-vercel-stand';

/** Модули, которые на стенде включены, если флаг не задан явно (как scripts/demo/local.sh). */
export const STAND_FEATURES_ON = ['REPORTS', 'SALES_SETTINGS', 'BK_WIZARD', 'PURCHASES', 'KANBAN', 'MERGE', 'BULK_TRANSFER', 'CALLBACK_V2', 'OP_BOARD', 'THEME_DARK'] as const;
/** Интеграции на стенде Vercel выключены всегда: стенд не принимает звонки и сообщения внешних сервисов. */
export const STAND_FEATURES_OFF = ['WAZZUP', 'TELEPHONY_ZADARMA', 'TELEPHONY_BEELINE'] as const;

/**
 * Каталог ассетов стенда (D-333): относительный, от корня проекта. Сид на сборке пишет в `<корень>/stand-assets`,
 * трассировка кладёт его в бандл функций, функция читает `/var/task/stand-assets`. `/tmp` сборки до запуска не доживает.
 */
export const STAND_ASSETS_DIR = 'stand-assets';

/** Пул соединений функции Vercel: экземпляров много, каждому хватает трёх. */
export const STAND_DB_POOL_MAX = '3';

/** 32 байта из главного секрета по метке (HKDF-SHA256). Разные метки — независимые ключи. */
export function deriveStandKey(master: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(label, 'utf8'), 32));
}

/**
 * Параметр строки подключения, который понимает только libpq: postgres.js отправил бы его серверу как настройку
 * сеанса, и вход упал бы. Neon кладёт его в DATABASE_URL; SCRAM postgres.js работает и без него.
 */
const LIBPQ_ONLY_PARAMS = ['channel_binding'];

/** Строка подключения без параметров только для libpq; не URL — как есть. */
export function driverDatabaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!LIBPQ_ONLY_PARAMS.some((p) => u.searchParams.has(p))) return url;
  for (const p of LIBPQ_ONLY_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

export type StandOverlay = {
  /** Что дописать в окружение (имя → значение). Значения секретов в журнал не выводятся. */
  set: Record<string, string>;
  /** Чего не хватает стенду: текст для журнала сборки и отказа запуска, без значений. */
  problems: string[];
};

/**
 * Чем дополнить окружение стенда на Vercel. Вызывать только в режиме стенда (isVercelStand). Повторный вызов на
 * дополненном окружении ничего не меняет, а problems остаются только у того, что взять неоткуда.
 */
export function vercelStandOverlay(e: Env): StandOverlay {
  const set: Record<string, string> = {};
  const problems: string[] = [];

  if (!has(e, 'APP_ORIGIN')) {
    const origin = standDefaultOrigin(e);
    if (origin) set.APP_ORIGIN = origin;
    else problems.push('APP_ORIGIN не задан, а VERCEL_PROJECT_PRODUCTION_URL пуст или не имя хоста: задайте APP_ORIGIN=https://<домен стенда>');
  }

  // База: Neon кладёт DATABASE_URL и POSTGRES_URL; DATABASE_URL приоритетнее
  const db = e.DATABASE_URL?.trim() || e.POSTGRES_URL?.trim();
  if (db) {
    const clean = driverDatabaseUrl(db);
    if (clean !== e.DATABASE_URL) set.DATABASE_URL = clean;
  } else {
    problems.push('нет базы: ни DATABASE_URL, ни POSTGRES_URL. Подключите Neon Postgres к проекту (Storage → Neon, docs/ops/VERCEL.md)');
  }
  // Пулер Neon — PgBouncer в режиме транзакций: без именованных подготовленных запросов и с маленьким пулом
  if (!has(e, 'DB_PREPARE')) set.DB_PREPARE = '0';
  if (!has(e, 'DB_POOL_MAX')) set.DB_POOL_MAX = STAND_DB_POOL_MAX;

  const missing = Object.keys(DERIVED_SECRETS).filter((n) => !has(e, n));
  const anySecretsKey = has(e, 'CRM_SECRETS_KID') || Object.keys(e).some((k) => k.startsWith('CRM_SECRETS_KEY_') && has(e, k));
  if (missing.length > 0 || !anySecretsKey) {
    const master = e[DEMO_SECRET_ENV]?.trim() ?? '';
    if (master.length >= DEMO_SECRET_MIN) {
      for (const name of missing) set[name] = deriveStandKey(master, DERIVED_SECRETS[name] as string).toString('base64url');
      if (!anySecretsKey) {
        set.CRM_SECRETS_KID = STAND_SECRETS_KID;
        set[`CRM_SECRETS_KEY_${STAND_SECRETS_KID}`] = deriveStandKey(master, SECRETS_KEY_LABEL).toString('base64');
      }
    } else if (missing.length > 0) {
      const why = master ? `короче ${DEMO_SECRET_MIN} символов` : 'не задан';
      problems.push(`${DEMO_SECRET_ENV} ${why}: из него выводятся ${missing.join(', ')}. Задайте ${DEMO_SECRET_ENV} (от ${DEMO_SECRET_MIN} символов, например openssl rand -base64 48) в Environment Variables проекта`);
    }
  }

  // Ассеты стенда — всегда в бандле функции: явное значение сборка и функция увидели бы по-разному (как флаги интеграций)
  if (e.CRM_ASSETS_DIR !== STAND_ASSETS_DIR) set.CRM_ASSETS_DIR = STAND_ASSETS_DIR;

  for (const f of STAND_FEATURES_ON) if (!has(e, `FEATURE_${f}`)) set[`FEATURE_${f}`] = '1';
  for (const f of STAND_FEATURES_OFF) if (e[`FEATURE_${f}`] !== '0') set[`FEATURE_${f}`] = '0';

  return { set, problems };
}
