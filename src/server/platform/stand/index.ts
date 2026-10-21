// Режим стенда на Vercel для этого процесса (D-318): водяной знак — из сборки ядра, окружение — process.env.
// Только сервер Node.js: ядро в edge и браузер не попадает (next.config.ts).
import { license as coreLicense } from '@crm/core';
import type { Watermark } from '@crm/core/license';
import { isVercelStand, vercelStandOverlay } from './overlay';

export { configuredAppOrigin, standDefaultOrigin, standRequested } from './origin';
export { DEMO_SECRET_ENV, DERIVED_SECRETS, driverDatabaseUrl, isVercelStand, STAND_FEATURES_OFF, STAND_FEATURES_ON, vercelStandOverlay } from './overlay';

type Env = Record<string, string | undefined>;

let cached: Watermark | null = null;

/** Водяной знак сборки ядра (читается один раз): customer задан — сборка клиента, режим стенда в ней не включается. */
export function buildWatermark(): Watermark {
  cached ??= coreLicense.buildWatermark();
  return cached;
}

/** Работает ли режим стенда на Vercel: VERCEL=1, CRM_STAND=1 и общая сборка. */
export function vercelStandActive(e: Env = process.env, watermark: Pick<Watermark, 'customer'> = buildWatermark()): boolean {
  return isVercelStand(e, watermark);
}

/**
 * Дополнить окружение процесса значениями стенда (хук старта Next, до приёма запросов). Вне режима — ничего.
 * Возвращает, чего не хватает (отказ запуска пишет startupConfigProblems). Значения не печатаются.
 */
export function applyVercelStandDefaults(target: Env = process.env, watermark: Pick<Watermark, 'customer'> = buildWatermark()): { active: boolean; problems: string[] } {
  if (!isVercelStand(target, watermark)) return { active: false, problems: [] };
  const { set, problems } = vercelStandOverlay(target);
  for (const [k, v] of Object.entries(set)) target[k] = v;
  return { active: true, problems };
}
