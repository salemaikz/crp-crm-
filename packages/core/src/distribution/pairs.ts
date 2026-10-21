// Правило спорной пары D-174 (PROCESS 7.6): что карточка напарника и статус пары дают второй карточке. Одно
// правило для раздачи (пул) и импорта «Записей»: пара не делится ни там, ни там (D-038).

/** Статус пары, который ограничивает раздачу: `merged` и `split_allowed` пару уже не держат. */
export type PairLimitStatus = 'open' | 'distinct';

/** Карточка напарника в пространстве: только то, что нужно правилу. */
export interface PairPartnerCard {
  ownerUserId: string | null;
  state: string;
  holdReason: string;
}

/** Что пара даёт карточке: двойник в пуле, держит оператор, заблокирована до решения РОП или ничего. */
export type PairEffect = 'twin' | 'blocked' | { heldBy: string } | null;

/** Состояния карточки напарника, при которых владелец «держит» пару (D-174). */
export const PAIR_HOLDING_STATES: ReadonlySet<string> = new Set(['new', 'retry', 'callback', 'agreed', 'client']);

const isReady = (c: PairPartnerCard): boolean => c.ownerUserId === null && c.state === 'new' && c.holdReason === '';

/** Правило одной строки таблицы D-174: что напарник Y (карточка) и пара дают кандидату. */
export function pairEffect(y: PairPartnerCard | undefined, status: PairLimitStatus): PairEffect {
  if (!y) return null;
  if (isReady(y)) return 'twin';
  if (y.state === 'do_not_call' && status === 'open') return 'blocked';
  if (y.ownerUserId !== null && PAIR_HOLDING_STATES.has(y.state)) return { heldBy: y.ownerUserId };
  if (y.ownerUserId === null && y.holdReason !== '' && status === 'open') return 'blocked';
  return null;
}
