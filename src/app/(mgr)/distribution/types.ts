// Формы данных экрана. Клиентским компонентам нельзя импортировать src/server/**, поэтому типы ответа API
// описаны здесь; page.tsx присваивает им формы из домена, и расхождение ловит typecheck.
export type ParticipantStatus = 'working' | 'paused' | 'absent';

export type ParticipantRow = {
  userId: string;
  name: string;
  status: ParticipantStatus;
  open: number;
  inDistribution: boolean;
  capUsed: number;
  cap: number;
  remaining: number;
  absentUntil: string | null;
};

export type PoolHoldKind = 'hold:dup_pair' | 'hold:import_conflict' | 'hold:no_working_phone' | 'hold:rule' | 'pair_blocked';

export type PoolItemRow = {
  cardId: string;
  clientId: string;
  name: string;
  createdAt: number;
  hasMobile: boolean;
  twinCardIds: string[];
  heldByUserId: string | null;
};

export type PoolPageData = {
  summary: { ready: number; held: Readonly<Record<PoolHoldKind, number>>; roomToday: number; overCap: number; ownerless: number };
  items: PoolItemRow[];
  next: string | null;
};

export type JournalKind = 'auto' | 'manual' | 'return' | 'absence' | 'release' | 'transfer' | 'inbound' | 'proposal' | 'merge' | 'import';

export type JournalRowData = {
  day: string;
  at: number;
  kind: JournalKind;
  runId: string | null;
  fromName: string | null;
  toName: string | null;
  actorId: string | null;
  count: number;
  countsToCap: number;
};

export type IssueResultData = {
  issued: string[];
  skipped: { cardId: string; reason: 'pair_held' | 'pair_blocked' | 'not_in_pool' | 'raced' }[];
  remaining: number;
  cap: number;
  replayed: boolean;
};

export type AbsenceRowData = {
  id: string;
  userId: string;
  userName: string;
  fromDay: string;
  toDay: string;
  substituteUserId: string | null;
  substituteName: string | null;
  createdAt: number;
};

export type AbsenceSavedData = AbsenceRowData & { applied: { acting: number; released: number }; replayed: boolean };

export type OwnerlessItemRow = {
  cardId: string;
  clientId: string;
  name: string;
  state: string;
  nextCallAt: number | null;
  version: number;
  createdAt: number;
};

export type OwnerlessPageData = { items: OwnerlessItemRow[]; next: string | null };

export type OwnerlessAssignData = { assigned: number; skipped: { cardId: string; reason: 'changed' }[]; replayed: boolean };

export type DistributionData = {
  pool: PoolPageData;
  participants: ParticipantRow[];
  journal: JournalRowData[];
  absences: AbsenceRowData[];
  ownerless: OwnerlessPageData;
  /** Местный день зрителя: даты по умолчанию в форме «Отсутствует». */
  today: string;
  canIssue: boolean;
  canManage: boolean;
  timeZone: string;
};
