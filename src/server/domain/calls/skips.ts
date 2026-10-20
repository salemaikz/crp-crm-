// Пропуск карточки (docs/calls-design.md §7): лимит в сутки считается под блокировкой пропусков сотрудника,
// поэтому 12 одновременных пропусков при лимите 10 дают ровно 10. Блокировка пропусков берётся ДО карточки.
import { calling } from '@crm/core';
import { NotFoundError } from '@/server/access';
import { toCoreActor } from '@/server/domain/cards/actor';
import { applyCardEffects } from '@/server/domain/cards/effects';
import { lockCardScoped } from '@/server/domain/cards/repo';
import { CallsDomainError } from './errors';
import { countSkipsToday, findPriorSkip, lockUserSkips } from './repo';
import { inCallsTx } from './tx';
import type { SubmitSkip } from './types';

export const submitSkip: SubmitSkip = async (deps, viewer, req) => {
  const spaceId = viewer.spaceId;
  if (spaceId === null) throw new NotFoundError();
  const now = deps.now();
  const ctx = await deps.context(spaceId, now);
  const today = ctx.calendar.localDay(now);

  return inCallsTx(async (tx) => {
    await lockUserSkips(tx, viewer.userId);
    const prior = await findPriorSkip(tx, req.opId);
    const skipsToday = await countSkipsToday(tx, viewer.userId, today);
    if (prior) {
      if (prior.userId !== viewer.userId || prior.cardId !== req.cardId) throw new CallsDomainError('opid_reused');
      return { status: 'duplicate' as const, skipsToday, skipLimit: ctx.queue.skipLimit };
    }
    const row = await lockCardScoped(tx, viewer, req.cardId, 'card.outcome');
    if (!row) throw new CallsDomainError('not_found');

    const result = calling.applyOutcome({
      card: row.snapshot,
      event: { type: 'skip', opId: req.opId, facts: { skipsToday } },
      actor: toCoreActor(viewer),
      now,
      settings: ctx.settings,
      calendar: ctx.calendar,
    });
    if (result.status === 'rejected') {
      throw new CallsDomainError(result.error, result.field, result.error === 'skip_limit' ? { skipLimit: ctx.queue.skipLimit } : {});
    }
    if (result.status !== 'applied') throw new Error('calls: пропуск ответил не applied');
    // Карточка не меняется: пишется только строка skips
    await applyCardEffects(
      tx,
      viewer,
      { id: row.snapshot.id, clientId: row.snapshot.clientId, spaceId: row.spaceId, ownerUserId: row.snapshot.ownerUserId, actingUserId: row.snapshot.actingUserId, phoneDigits: row.phoneDigits, opId: req.opId },
      result.effects,
      now,
      ctx,
    );
    return { status: 'skipped' as const, skipsToday: skipsToday + 1, skipLimit: ctx.queue.skipLimit };
  });
};
