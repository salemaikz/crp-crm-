// Настройки: схема ConfigV1, слои пресета, слияние, дифф, обновление пресета, версии и ревизии.
// Нормативно: docs/CONFIG.md, D-014, D-060, D-061, D-081…D-083. Руководство builder — README.md.
export * from './json.js';
export * from './paths.js';
export * from './merge.js';
export * from './diff.js';
export * from './update.js';
export * from './steps.js';
export * from './layers.js';
export * from './version.js';
export * from './revisions.js';
export * from './validate.js';
export { placeholdersOf } from './integrity.js';
export * from './schema/constants.js';
export { GlobalConfigV1, SpaceConfigV1, ConfigSetV1, GlobalField, SpaceField } from './schema/v1.js';
export { KEY_RE, Key, I18n, type I18nText } from './schema/primitives.js';
export { RoleSlot, type RoleSlotV1 } from './schema/roles.js';
export type { ConfigMigration, ConfigScopeKind } from './migrations/index.js';
export { CONFIG_MIGRATIONS } from './migrations/index.js';
