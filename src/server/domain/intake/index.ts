// Публичный вход модуля intake: HTTP-обработчики ingest/v1 для маршрутов и управление ключами для консоли.
export { handleDemand, handleLeads, MAX_BODY_BYTES } from './http';
export { createKey, KeyInputError, listKeys, parseScopes, revokeKey, uiKeys, type KeyInfo } from './keyService';
export { INGEST_SCOPES, type IngestScope } from './types';
export { createProposalClient, proposeContact, type ProposeInput, type ProposeResult } from './propose';
export { lockIntake, lockIntakeFirst } from './repo';
export { applyMerge, mergeEnabled, previewMerge, type MergeChoice, type MergeInput, type MergePreview, type MergeResult, type OwnerFrom } from './merge';
export { MergeError, mergeBadRequest, mergeConflict, type MergeErrorDetail } from './mergeErrors';
export { MERGE_TABLES, type MergeConflict, type FillField, type MoveTable } from './mergePlan';
export { lockMergeKeys, releaseDupPairHolds } from './mergeRepo';
