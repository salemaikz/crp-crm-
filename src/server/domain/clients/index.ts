// Публичный API модуля клиентов для маршрутов и страниц. Репозиторий (repo.ts) наружу не выходит.
export { addContact, archiveContactById, updateContact, type PatchContactResult } from './contacts';
export { fieldViewer, loadClientsConfig, type ClientsConfig } from './config';
export { FieldIssuesError } from './errors';
export {
  addContactBody,
  addPhoneBody,
  parseBody,
  parseListQuery,
  patchBody,
  patchContactBody,
  patchPhoneBody,
  type ListQuery,
  type PatchBody,
} from './input';
export { addPhone, updatePhone, type AddPhoneResult } from './phones';
export { findSurvivor, getClientCard, getClientFeed, listClients, loadClientPage, updateClient, type ClientPage } from './service';
export { CARD_STATES } from './types';
export type { CardHeadDto, CardState, ClientCardDto, ClientList, ClientRow, ContactDto, PhoneDto, PhoneKind } from './types';
