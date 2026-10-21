// Режим стенда на Vercel для этого процесса (D-318): водяной знак — из сборки ядра, признак стенда — из бандла,
// окружение — process.env. Только сервер Node.js: ядро в edge и браузер не попадает (next.config.ts).
import { license as coreLicense } from '@crm/core';
import { standBuildMarked } from './origin';
import { isVercelStand, STAND_PHONE_PREFIX, vercelStandOverlay, type StandBuild } from './overlay';

export { configuredAppOrigin, standBuildMarked, standDefaultOrigin, standRequested } from './origin';
export {
  DEMO_SECRET_ENV,
  DERIVED_SECRETS,
  driverDatabaseUrl,
  isVercelStand,
  STAND_FEATURES_OFF,
  STAND_FEATURES_ON,
  STAND_PHONE_PREFIX,
  vercelStandOverlay,
  type StandBuild,
} from './overlay';

type Env = Record<string, string | undefined>;

let customer: string | null | undefined;

/** Сборка этого процесса: клиент из водяного знака ядра (читается один раз) и признак сборки стенда. */
export function currentBuild(): StandBuild {
  if (customer === undefined) customer = coreLicense.buildWatermark().customer;
  return { customer, standBuild: standBuildMarked() };
}

/** Работает ли режим стенда на Vercel: VERCEL=1, CRM_STAND=1, общая сборка с признаком стенда. */
export function vercelStandActive(e: Env = process.env, build: StandBuild = currentBuild()): boolean {
  return isVercelStand(e, build);
}

/**
 * Номер не из служебного блока +7 709 на стенде Vercel — отказ (D-318): на стенд не вводят настоящие номера.
 * `digits` — канон 7XXXXXXXXXX. Вне режима — всегда false.
 */
export function standPhoneRejected(digits: string, e: Env = process.env, build: StandBuild = currentBuild()): boolean {
  return isVercelStand(e, build) && !digits.startsWith(STAND_PHONE_PREFIX);
}

/**
 * Дополнить окружение процесса значениями стенда (хук старта Next, до приёма запросов). Вне режима — ничего.
 * Возвращает, чего не хватает (отказ запуска пишет startupConfigProblems). Значения не печатаются.
 */
export function applyVercelStandDefaults(target: Env = process.env, build: StandBuild = currentBuild()): { active: boolean; problems: string[] } {
  if (!isVercelStand(target, build)) return { active: false, problems: [] };
  const { set, problems } = vercelStandOverlay(target);
  for (const [k, v] of Object.entries(set)) target[k] = v;
  return { active: true, problems };
}
