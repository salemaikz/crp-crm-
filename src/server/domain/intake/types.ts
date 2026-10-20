// Типы приёма лидов ingest/v1 (INTEGRATIONS §5). Ответы содержат только счётчики и статусы.

export const INGEST_SCOPES = ['leads:write', 'leads:demand'] as const;
export type IngestScope = (typeof INGEST_SCOPES)[number];

/** Кто пришёл по ключу. Строится только `authenticateKey()`; это не сотрудник и не SystemActor. */
export interface IngestPrincipal {
  readonly kind: 'ingest';
  readonly keyId: string;
  readonly spaceId: string;
  readonly spaceKey: string;
  /** `sources.<key>` из настроек; идемпотентность и externalId привязаны к нему, а не к ключу. */
  readonly sourceKey: string;
  readonly scopes: readonly IngestScope[];
}

/** Статус записи партии (полный отчёт). */
export type ItemStatus =
  | 'created'
  | 'merged'
  | 'held_pair'
  | 'held_rule'
  | 'rejected_rule'
  | 'stop_list'
  | 'no_working_phone'
  | 'invalid';

/** Коды невалидной записи: без значений полей. */
export type InvalidCode = 'name_required' | 'person_not_allowed';

export interface DroppedFields {
  contactName: number;
  iin: number;
  custom: number;
  orgId: number;
  email: number;
  website: number;
}

export const emptyDropped = (): DroppedFields => ({ contactName: 0, iin: 0, custom: 0, orgId: 0, email: 0, website: 0 });

export interface FullCounts {
  received: number;
  created: number;
  merged: number;
  heldPair: number;
  heldRule: number;
  rejectedRule: number;
  stopList: number;
  noWorkingPhone: number;
  invalid: number;
}

export interface FullItem {
  index: number;
  externalId: string | null;
  status: ItemStatus;
  code?: InvalidCode;
}

export interface FullReport {
  batchId: string;
  replayed: boolean;
  receivedAt: number;
  counts: FullCounts;
  droppedFields: DroppedFields;
  items: FullItem[];
  poolReady: number;
}

/** Краткий отчёт источника без `detailedReport`: ни «номер есть в базе», ни `poolReady`. */
export interface BriefReport {
  batchId: string;
  replayed: boolean;
  receivedAt: number;
  counts: { received: number; accepted: number; invalid: number };
  droppedFields: DroppedFields;
  items: { index: number; externalId: string | null; status: 'accepted' | 'invalid'; code?: InvalidCode }[];
}

export type BatchReport = FullReport | BriefReport;

/** Ответ `GET demand` (INTEGRATIONS 5.3). Только числа, даты и признаки. */
export interface DemandResponse {
  asOf: number;
  timezone: string;
  accepting: boolean;
  maxBatch: number;
  horizonWorkdays: number;
  today: { date: string; isWorkday: boolean; operators: number; capPerOperator: number; capacity: number; issued: number; remaining: number };
  days: { date: string; operators: number; capacity: number }[];
  returnsExpected: number;
  poolReady: number;
  needToday: number;
  next: { date: string; capacity: number; returnsDue: number } | null;
  bufferDays: number;
  needNext: number;
  needTotal: number;
}
