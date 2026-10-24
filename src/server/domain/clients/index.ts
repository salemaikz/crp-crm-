// Публичный API модуля клиентов для маршрутов и страниц. Репозиторий (repo.ts) наружу не выходит.
export { addContact, archiveContactById, updateContact, type PatchContactResult } from './contacts';
export { cardFieldViewer, updateCardFields, type CardFieldsResult } from './cardFields';
export { loadCatalogLabels, loadFeedCatalog, type CatalogLabels, type FeedCatalog } from './labels';
export { fieldViewer, loadClientsConfig, type ClientsConfig } from './config';
export { DetailedConflictError, FieldConflictError, FieldIssuesError } from './errors';
export {
  addContactBody,
  addPhoneBody,
  createNoteBody,
  pinNoteBody,
  patchCardBody,
  parseBody,
  parseListQuery,
  patchBody,
  patchContactBody,
  patchPhoneBody,
  type ListQuery,
  type PatchBody,
  type PatchCardBody,
} from './input';
export { addPhone, updatePhone, type AddPhoneResult } from './phones';
export { findSurvivor, getClientCard, getClientDeals, getClientFeed, getClientSummaryFor, listClients, loadClientPage, updateClient, type ClientPage } from './service';
export { CARD_STATES } from './types';
export type { CardBoardDto, CardHeadDto, CardState, CardTone, ClientCan, ClientCardDto, ClientList, ClientRow, ContactDto, PhoneDto, PhoneKind } from './types';
export type { ClientSummaryDto, DealRowDto, NoteDto } from '../timeline';
