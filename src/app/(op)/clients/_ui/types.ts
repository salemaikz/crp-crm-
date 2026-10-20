// Типы данных, которые страница клиентов передаёт клиентским компонентам. Совпадают по форме с DTO
// домена (проверяет TypeScript при передаче props), но не импортируют его: файлы с 'use client'
// не видят ядро и src/server (tests/unit/layers.test.ts).

export type Label = { ru: string; kk?: string };
export type FieldValue = string | number | boolean | string[];

export type FieldView = {
  key: string;
  type: string;
  label: Label;
  access: 'edit' | 'read';
  options: Array<{ key: string; label: Label; archived: boolean }>;
  value: FieldValue | null;
  href: string | null;
  showOn: { card: boolean; kanban: boolean; list: boolean };
  archived: boolean;
};

export type PhoneView = {
  id: string;
  e164: string;
  ext: string;
  kind: 'mobile' | 'landline' | 'unknown';
  working: boolean;
  primary: boolean;
  contactId: string | null;
  hasWhatsapp: 'yes' | 'no' | 'unknown';
};

export type ContactView = {
  id: string;
  name: string;
  position: string;
  isDecisionMaker: boolean;
  callHint: string;
  note: string;
  fields: { fields: FieldView[] };
};

export type LegalFormOption = { key: string; label: Label };

export type ClientFieldsView = {
  id: string;
  name: string;
  legalForm: string;
  orgId: string;
  region: string;
  address: string;
  email: string;
  emailHref: string | null;
  website: string;
  websiteHref: string | null;
  can: { edit: boolean; editIdentity: boolean };
  fields: { fields: FieldView[] };
};

export type FeedItemView = {
  id: string;
  kind: string;
  group: string;
  at: number;
  actor: { id: string; name: string } | null;
  refType: string;
  refId: string;
  data: Record<string, unknown>;
  /** Сообщение мессенджера (kind = 'message'): текст, удалено ли, статус доставки. */
  message?: { text: string | null; deleted: boolean; status: string | null };
};

/**
 * Подписи для ленты (простые данные: уходят из серверной страницы в клиентский компонент):
 * поля (`client:key`, `contact:key`), варианты (`client:key:option`, формы собственности `legal_form:key`),
 * номера и контакты по id.
 */
export type FeedLabels = {
  fields: Record<string, string>;
  options: Record<string, string>;
  phones: Record<string, string>;
  contacts: Record<string, string>;
};
