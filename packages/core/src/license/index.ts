// Лицензия (P10, ARCHITECTURE §8.4, D-029, D-211): формат, проверка подписи офлайн, правило часов, состояния.
// Чистые функции: время приходит параметром, ключи и водяной знак — из сборки (keys.ts) или параметром в тестах.
export {
  DAY_MS,
  LICENSE_MAX_LENGTH,
  LICENSE_PREFIX,
  assembleLicense,
  decodeLicense,
  licensePayloadSchema,
  signingInput,
  toBase64Url,
} from './format';
export type { DecodeResult, Decoded, InvalidReason, LicensePayload } from './format';
export { TEST_KEYS, buildWatermark, embeddedKeys, isTestKid, parseTrustedKeys, publicKeyObject, rawPublicKeyBase64 } from './keys';
export type { TrustedKeys, Watermark } from './keys';
export { verifyLicense } from './verify';
export type { Verdict, VerifyExpect } from './verify';
export { CLOCK_BACKWARD_TOLERANCE_MS, CLOCK_JUMP_STEP_INTERVAL_MS, CLOCK_MAX_STEP_MS, advanceClock } from './clock';
export type { ClockInput, ClockJump, ClockResult } from './clock';
export { EXPIRING_DAYS, INVALID_GRACE_DAYS, LICENSE_STATUSES, LOCKING_ACCESS, evaluateLicense, hasFeature, missingAllowed } from './state';
export type { EvaluateInput, Evaluation, LicenseAccess, LicenseStatus } from './state';
