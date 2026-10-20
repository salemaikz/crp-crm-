// DTO клиентов: то, что сервер отдаёт API и страницам. Скрытых полей и чужих данных здесь нет.
import type { fields } from '@crm/core';

export type PhoneKind = 'mobile' | 'landline' | 'unknown';
export type CardState = 'new' | 'retry' | 'callback' | 'agreed' | 'client' | 'not_interested' | 'not_target' | 'do_not_call' | 'written_off';

/** Закрытый список состояний карточки (фильтр списка). */
export const CARD_STATES: readonly CardState[] = [
  'new',
  'retry',
  'callback',
  'agreed',
  'client',
  'not_interested',
  'not_target',
  'do_not_call',
  'written_off',
];

export type PhoneDto = {
  id: string;
  e164: string;
  ext: string;
  kind: PhoneKind;
  working: boolean;
  primary: boolean;
  contactId: string | null;
  hasWhatsapp: 'yes' | 'no' | 'unknown';
};

export type ContactDto = {
  id: string;
  name: string;
  position: string;
  isDecisionMaker: boolean;
  callHint: string;
  note: string;
  fields: fields.Projection;
};

/** Шапка карточки обзвона текущего пространства; счётчики с карточки, без пересчёта (PROCESS 9.2). */
export type CardHeadDto = {
  id: string;
  state: CardState;
  holdReason: string;
  nextCallAt: number | null;
  attempts: number;
  lpr: '' | 'yes' | 'no';
  isTarget: '' | 'yes' | 'no';
  lastOutcomeCode: string;
  ownerName: string | null;
  actingName: string | null;
  counters: {
    callsTotal: number;
    noAnswerTotal: number;
    connectsTotal: number;
    firstConnectAt: number | null;
    lastConnectAt: number | null;
    lastTouchAt: number | null;
  };
};

export type ClientCardDto = {
  id: string;
  kind: 'company' | 'person';
  name: string;
  legalForm: string;
  orgId: string;
  region: string;
  address: string;
  email: string;
  emailHref: string | null;
  website: string;
  websiteHref: string | null;
  sourceKind: string;
  updatedAt: number;
  can: { edit: boolean; editIdentity: boolean };
  card: CardHeadDto | null;
  phones: PhoneDto[];
  primaryPhone: PhoneDto | null;
  decisionMaker: { contactId: string; name: string } | null;
  contacts: ContactDto[];
  /** Поля контакта из настроек для формы нового контакта (без значений). */
  contactFields: fields.Projection;
  fields: fields.Projection;
};

export type ClientRow = {
  id: string;
  cardId: string;
  name: string;
  state: CardState;
  holdReason: string;
  nextCallAt: number | null;
  lastTouchAt: number | null;
  primaryPhone: string | null;
  values: Record<string, fields.FieldValue>;
};

export type ClientList = { items: ClientRow[]; next: string | null; hint?: 'short' };
