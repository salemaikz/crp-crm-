// Мессенджер (O7a, дизайн docs/reports-plugins-design.md §8): применение событий вебхука, окно чата, согласие.
// Плагин провайдера домен видит только через PluginRegistry в deps (contract.ts).
export { applyMessengerEvents, CHANNEL_REFRESH_MS, REPLY_TASKS_PER_DAY, resetChannelRefreshForTests } from './apply';
export { CHAT_WINDOW_RATE, openChatWindow, pickChannel } from './chatWindow';
export { getMessengerConsent, LINK_OPENED_RATE, recordLinkOpened, setMessengerConsent } from './consent';
export { loadMessengerSettings, MessengerSettingsError } from './settings';
export { ChatWindowError, type ChatWindowResult, type ConsentAction, type MessengerDeps, type MessengerSettings } from './types';
