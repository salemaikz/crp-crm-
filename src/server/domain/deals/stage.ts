// Ручной этап и проигрыш сделки (B6, docs/deals-handoffs-design.md §5.7, PROCESS 4.2, 3.5 № 21).
// Блокировки: карточка → сделка; повтор — `client_events.id = opId`; версия сделки — токен правки.
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import { throwNotFoundOrConflict } from '@/server/access/scope';
import type { LockedCard } from '@/server/domain/booking/types';
import type { Sql } from '@/server/platform/db';
import { CardRejectedError, DealDomainError } from './errors';
import { requirePurchases, requireSpace } from './guards';
import { pipelineOf, toDealView } from './read';
import { updateDealStageScoped } from './repo';
import {
  dealBookingFacts,
  findDealScoped,
  findFeedById,
  hasOpenStepTask,
  hasOtherDeal,
  insertDealFeedWithId,
  insertStepTask,
  lockCardById,
  lockDealById,
  lockDealScoped,
  loseDealScoped,
  type DealFullRow,
} from './repo.purchase';
import { isEmptyFieldValue, lostStageOf, stageRequirements } from './rules';
import { inDealsTx } from './tx';
import type { DealView, DealsSettings, LoseDeal, MoveDealStage } from './types';

const REASON_TEXT_MAX = 500;
/** Шаг «в прошлом» допустим на 5 минут (часы телефона и сервера расходятся). */
const NEXT_STEP_PAST_TOLERANCE_MS = 5 * 60_000;

async function lockForEdit(viewer: Viewer, tx: Sql, dealId: string, spaceId: string): Promise<{ card: LockedCard; deal: DealFullRow }> {
  const probe = await findDealScoped(viewer, tx, dealId, 'deal.edit');
  if (!probe || probe.spaceId !== spaceId) throw new NotFoundError();
  const card = await lockCardById(tx, probe.cardId);
  if (!card) throw new NotFoundError();
  const deal = await lockDealScoped(viewer, tx, { dealId, perm: 'deal.edit' });
  if (!deal) throw new NotFoundError();
  return { card, deal };
}

async function replayOf(viewer: Viewer, tx: Sql, a: { opId: string; kind: string; dealId: string; settings: DealsSettings; now: number }): Promise<DealView | null> {
  const seen = await findFeedById(tx, a.opId);
  if (!seen) return null;
  if (seen.kind !== a.kind || seen.dealId !== a.dealId) throw new DealDomainError('request_reused');
  const row = await lockDealById(tx, a.dealId);
  if (!row) throw new NotFoundError();
  return toDealView(row, pipelineOf(a.settings, row.pipelineKey), a.now);
}

async function currentView(viewer: Viewer, tx: Sql, dealId: string, settings: DealsSettings, now: number): Promise<DealView> {
  const row = await lockDealById(tx, dealId);
  if (!row) throw new NotFoundError();
  return toDealView(row, pipelineOf(settings, row.pipelineKey), now);
}

export const moveDealStage: MoveDealStage = async (deps, viewer, input) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  if (input.nextStep) {
    if (!Number.isFinite(input.nextStep.dueAt) || input.nextStep.dueAt < now - NEXT_STEP_PAST_TOLERANCE_MS) throw new BadRequestError('next_step');
    if (input.nextStep.kind !== 'call' && input.nextStep.kind !== 'meeting') throw new BadRequestError('next_step');
  }
  const settings = await deps.settings(spaceId, now);

  return inDealsTx(async (tx) => {
    const { deal } = await lockForEdit(viewer, tx, input.dealId, spaceId);
    const replay = await replayOf(viewer, tx, { opId: input.opId, kind: 'deal.stage', dealId: deal.id, settings, now });
    if (replay) return replay;
    if (deal.version !== input.version) throw new ConflictError();
    if (deal.status !== 'open') throw new DealDomainError('deal_closed');

    const pipeline = pipelineOf(settings, deal.pipelineKey);
    const target = pipeline.stages.find((s) => s.key === input.stageKey);
    if (!target) throw new DealDomainError('stage_unknown');
    if (target.kind === 'won') throw new DealDomainError('use_purchase');
    if (target.kind === 'lost') throw new DealDomainError('use_lose');
    const current = pipeline.stages.find((s) => s.key === deal.stageKey);
    if (current && current.key === target.key) return toDealView(deal, pipeline, now);
    // Назад — только с правом `deal.move_back` по роли (PROCESS 4.2)
    if (current && target.order < current.order && scopeOf(viewer, 'deal.move_back') === null) throw new ForbiddenError();

    const req = stageRequirements(target);
    if (req.nextTask && !input.nextStep && !(await hasOpenStepTask(tx, deal.id))) throw new DealDomainError('next_step_required');
    const missing = req.fields.filter((k) => isEmptyFieldValue(deal.custom?.[k]));
    if (req.booking || req.attendance) {
      const facts = await dealBookingFacts(tx, deal.id);
      if (req.booking && !facts.booking) missing.push('booking');
      if (req.attendance && !facts.attended) missing.push('attendance');
    }
    if (missing.length > 0) throw new DealDomainError('stage_fields_required', missing);

    const ok = await updateDealStageScoped(viewer, tx, { id: deal.id, version: input.version, stageKey: target.key, at: now });
    if (!ok) await throwNotFoundOrConflict(viewer, tx, 'deal', deal.id);
    if (input.nextStep) {
      await insertStepTask(tx, { spaceId, clientId: deal.clientId, dealId: deal.id, kind: input.nextStep.kind, dueAt: input.nextStep.dueAt, assigneeUserId: viewer.userId, at: now });
    }
    const written = await insertDealFeedWithId(tx, {
      id: input.opId,
      clientId: deal.clientId,
      spaceId,
      dealId: deal.id,
      kind: 'deal.stage',
      actorId: viewer.userId,
      at: now,
      data: { dealId: deal.id, from: deal.stageKey, to: target.key, cause: 'manual' },
    });
    if (!written) throw new DealDomainError('request_reused');
    return currentView(viewer, tx, deal.id, settings, now);
  });
};

export const loseDeal: LoseDeal = async (deps, viewer, input) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const reason = settings.lostReasons.find((r) => r.key === input.reasonCode);
  if (!reason) throw new DealDomainError('reason_unknown');
  const text = input.reasonText.trim();
  if (text.length > REASON_TEXT_MAX) throw new BadRequestError('reason_text');
  if (reason.needsText && text === '') throw new DealDomainError('reason_text_required');

  return inDealsTx(async (tx) => {
    const { card, deal } = await lockForEdit(viewer, tx, input.dealId, spaceId);
    const replay = await replayOf(viewer, tx, { opId: input.opId, kind: 'deal.lost', dealId: deal.id, settings, now });
    if (replay) return replay;
    if (deal.version !== input.version) throw new ConflictError();
    if (deal.status !== 'open') throw new DealDomainError('deal_closed');

    const pipeline = pipelineOf(settings, deal.pipelineKey);
    const lostKey = lostStageOf(pipeline)?.key ?? deal.stageKey;
    const ok = await loseDealScoped(viewer, tx, {
      id: deal.id,
      version: input.version,
      stageKey: lostKey,
      reasonCode: reason.key,
      reasonText: reason.needsText ? text : '',
      at: now,
    });
    if (!ok) await throwNotFoundOrConflict(viewer, tx, 'deal', deal.id);
    // Текст причины — ПДн: в ленту уходит только код
    const written = await insertDealFeedWithId(tx, { id: input.opId, clientId: deal.clientId, spaceId, dealId: deal.id, kind: 'deal.lost', actorId: viewer.userId, at: now, data: { dealId: deal.id, reasonCode: reason.key } });
    if (!written) throw new DealDomainError('request_reused');

    // Карточка (№ 21) — только из «Договорились»: последняя открытая сделка уводит её в «Не интересует» / «Не целевой»
    if (card.state === 'agreed') {
      const hasOtherOpenDeal = await hasOtherDeal(tx, { spaceId, clientId: deal.clientId, status: 'open', exceptId: deal.id });
      const result = await deps.cards.applyBookingEvent(
        tx,
        viewer,
        card,
        { type: 'deal_lost', opId: input.opId, dealId: deal.id, reasonCode: reason.key, softness: reason.softness, facts: { hasOtherOpenDeal } },
        now,
      );
      if (result.status === 'rejected') throw new CardRejectedError(result.error);
    }
    return currentView(viewer, tx, deal.id, settings, now);
  });
};
