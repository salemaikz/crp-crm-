// Формы данных экрана «Спорные пары» (зеркало ответов /api/distribution/pairs; домен присваивает их странице).
export type PairPhone = { phone: string | null; working: boolean; shared: boolean; stopListed: boolean };

export type PairSide = {
  clientId: string;
  cardId: string;
  name: string;
  orgId: string;
  state: string;
  ownerUserId: string | null;
  ownerName: string | null;
  lastTouchAt: number | null;
  phones: PairPhone[];
};

export type PairRow = {
  id: string;
  reason: 'shared_phone' | 'name_and_head';
  status: 'open' | 'merged' | 'distinct' | 'split_allowed';
  createdAt: number;
  a: PairSide | null;
  b: PairSide | null;
};

export type PairsData = {
  items: PairRow[];
  /** Курсор следующей страницы пар; null — всё показано. */
  next: string | null;
  /** Право решать по паре (`card.assign`). */
  canResolve: boolean;
  /** Слияние включено флагом и есть право `client.merge`. */
  canMerge: boolean;
  timeZone: string;
};

export type MergePreview = {
  pairId: string;
  survivorClientId: string;
  loserClientId: string;
  owner: 'auto' | 'survivor' | 'other';
  result: { state: string; ownerUserId: string | null; ownerName: string | null } | null;
  moves: Partial<Record<string, number>>;
  phones: { moved: number; duplicates: number };
  fills: string[];
  conflicts: Array<'booking_conflict' | 'other_space'>;
  fingerprint: string;
};
