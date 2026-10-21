// Лицензия на сервере (P10): окружение проверки, пересчёт состояния, задача воркера.
// Состояние для доступа берётся через currentLicenseState() из src/server/access/license.ts.
export { DEFAULT_LICENSE_PATH, defaultLicenseEnv, licenseEnv, licensePath, readLicenseFile, type LicenseEnv } from './env';
export { refreshLicense, type LicenseSnapshot } from './service';
export { licenseJobHandler } from './job';
export { currentLicenseSnapshot, invalidateLicenseCache, LICENSE_CACHE_TTL_MS } from './current';
export { readLicenseRow, type LicenseRow } from './repo';
export { resetLicenseClock, type ClockResetResult } from './reset';
