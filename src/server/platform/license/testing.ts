// Только тесты: подмена ключей, водяного знака, файла и часов проверки лицензии. В production — ошибка.
import { isProduction } from '../env';
import type { LicenseEnv } from './env';

type EnvGlobal = typeof globalThis & { __crmLicenseEnvOverride?: Partial<LicenseEnv> };
const g = globalThis as EnvGlobal;

export function overrideLicenseEnvForTests(patch: Partial<LicenseEnv>): void {
  if (isProduction()) throw new Error('лицензия: подмена окружения запрещена в production');
  g.__crmLicenseEnvOverride = { ...g.__crmLicenseEnvOverride, ...patch };
}

export function resetLicenseEnvForTests(): void {
  g.__crmLicenseEnvOverride = undefined;
}
