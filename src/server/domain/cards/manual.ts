// Ручные и системные события карточки, кроме итога звонка (docs/tasks-team-design.md §1.1, D-251):
// `release`, `absence`, `transfer`, `reopen`, `dnc_clear`, `close_from_menu`, `merge`. Один путь для всех:
// блокировка → ядро `calling.applyOutcome` → `persistTransition`. Правил состояния здесь нет — только ядро.
// Порядок блокировок (§1.2): карточку блокируют после advisory и строк clients; здесь это делает вызывающий.
import { calling } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { getDb, type Sql } from '@/server/platform/db';
import { toCoreActor } from './actor';
import { CardActionError } from './errors';
import { persistTransition } from './persist';
import { lockCardScoped } from './repo';
import { loadCallingContext } from './settings';
import type { CallingContext, CardActor, CardEventPerm, LockedCardRow } from './types';

export type { CardEventPerm } from './types';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Применить событие к уже заблокированной карточке: ядро → persistTransition. `rejected` не бросает. */
export async function applyCardEventLocked(
  tx: Sql,
  actor: CardActor,
  row: LockedCardRow,
  ctx: CallingContext,
  event: calling.CardEvent,
  now: number,
  opts: { opId?: string } = {},
): Promise<calling.TransitionResult> {
  const result = calling.applyOutcome({ card: row.snapshot, event, actor: toCoreActor(actor), now, settings: ctx.settings, calendar: ctx.calendar });
  if (result.status === 'applied' || result.status === 'fact_only') {
    await persistTransition(tx, actor, { ctx, before: row, result, at: now, ...(opts.opId ? { opId: opts.opId } : {}) });
  }
  return result;
}

export interface RunCardEventOpts {
  opId?: string;
  /** Внутри той же транзакции после записи перехода (заметка с комментарием, аудит). */
  inTx?: (tx: Sql, after: calling.AppliedResult) => Promise<void>;
  /** «Сейчас» (для тестов); по умолчанию Date.now(). */
  now?: number;
}

/**
 * Тх: lockCardScoped(viewer, cardId, perm) → build(snapshot) → applyCardEventLocked. Нет карточки — NotFoundError.
 * Отказ ядра — CardActionError; `fact_only` для ручных событий не бывает (они не звонки).
 */
export async function runCardEvent(
  viewer: Viewer,
  cardId: string,
  perm: CardEventPerm,
  build: (snap: calling.CardSnapshot) => calling.CardEvent,
  opts: RunCardEventOpts = {},
): Promise<calling.AppliedResult> {
  if (viewer.spaceId === null) throw new NotFoundError();
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(async (tx) => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        const now = opts.now ?? Date.now();
        const row = await lockCardScoped(tx, viewer, cardId, perm);
        if (!row || row.spaceId !== viewer.spaceId) throw new NotFoundError();
        const ctx = await loadCallingContext(row.spaceId, now);
        const result = await applyCardEventLocked(tx, viewer, row, ctx, build(row.snapshot), now, opts.opId ? { opId: opts.opId } : {});
        if (result.status === 'rejected') throw new CardActionError(result.error, result.field, row.snapshot.version);
        if (result.status !== 'applied') throw new CardActionError('invalid_transition', null, row.snapshot.version);
        if (opts.inTx) await opts.inTx(tx, result);
        return result;
      });
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}
