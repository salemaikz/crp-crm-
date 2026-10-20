// Публичный вход модуля intake: HTTP-обработчики ingest/v1 для маршрутов и управление ключами для консоли.
export { handleDemand, handleLeads, MAX_BODY_BYTES } from './http';
export { createKey, KeyInputError, listKeys, parseScopes, revokeKey, uiKeys, type KeyInfo } from './keyService';
export { INGEST_SCOPES, type IngestScope } from './types';
