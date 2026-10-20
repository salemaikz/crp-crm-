// Модуль интеграций (дизайн docs/reports-plugins-design.md §7): режимы каналов, приём вебхуков, контекст плагина,
// пригодность подключения, строки inbox для воркера. Плагины приходят через IntegrationDeps (pluginDeps()).
export { FALLBACK_MODES, getChannelModes } from './modes';
export { receiveWebhook, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_ITEMS, WEBHOOK_RATE_LIMIT, LAST_EVENT_STEP_MS } from './webhook';
export { buildCtx, IntegrationConfigError } from './ctx';
export { gateFor, usabilityOf, loadInboxItem, purgeWebhookPayloads, defaultFlagOn, defaultLicensed } from './service';
export type { IntegrationDeps, IntegrationRow, InboxRow } from './types';
