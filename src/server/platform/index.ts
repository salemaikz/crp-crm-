// Платформа сервера: БД и миграции, аудит, лимиты, флаги, окружение.
// Модули подключаются прямыми путями (`@/server/platform/db` и т. д.), чтобы не тянуть лишнее.
export { isFeatureEnabled, FEATURES, type FeatureName } from './flags';
export { databaseUrl, isProduction, readEnv, type Env } from './env';
