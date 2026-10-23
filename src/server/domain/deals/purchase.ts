// Покупка, её правка и отмена (B6, docs/deals-handoffs-design.md §5.4–5.5, D-248, D-249).
// Порядок блокировок (D-251): карточка → сделка → передача → задачи. Идемпотентность — событие ленты с
// `client_events.id` = requestId/opId (у новой сделки ещё и `deals.request_id`): строка уже есть → повтор,
// ответ — текущее состояние без эффектов; есть, но про другое → `request_reused`. Сервис сам пишет сделку,
// затем событие карточки через CardPort; отказ ядра откатывает всё действие (409).
import { NotFoundError, BadRequestError, ConflictError, type SystemActor, type Viewer } from '@/server/access';
import type { LockedCard } from '@/server/domain/booking/types';
import { cancelHandoffOfDeal, createHandoffForDeal } from '@/server/domain/handoffs/create';
import { findHandoffIdOfDeal } from '@/server/domain/handoffs/repo';
import { writeAudit } from '@/server/platform/audit';
import type { Sql } from '@/server/platform/db';
import { CardRejectedError, DealDomainError } from './errors';
import { requirePurchases, requireSpace } from './guards';
import { pipelineOf, toDealView } from './read';
import {
  findDealScoped,
  findFeedById,
  hasOtherDeal,
  insertDealFeedWithId,
  insertDealNote,
  insertDealNotification,
  insertWonDeal,
  lastWonFromStage,
  lockCardById,
  lockCardScoped,
  lockDealById,
  lockDealScoped,
  markDealWon,
  markWonDealLost,
  reopenWonDeal,
  updatePurchaseScoped,
  type DealFullRow,
} from './repo.purchase';
import { checkAmount, lostStageOf, purchaseMoment, wonStageOf } from './rules';
import { inDealsTx } from './tx';
import type { CancelPurchase, DealPipelineInfo, DealsDeps, DealsSettings, DealView, EditPurchase, EditPurchaseInput, PurchaseResult, RegisterPurchase } from './types';

type Actor = Viewer | SystemActor;
type CardRef = Pick<LockedCard, 'id' | 'clientId' | 'spaceId' | 'ownerUserId'>;

const actorIdOf = (a: Actor): string | null => (a.kind === 'user' ? a.userId : null);
const COMMENT_MAX = 500;
/** Причина системного проигрыша: покупка-ошибка у сделки, созданной сразу выигранной (в отчёт причин не входит). */
export const INPUT_ERROR_REASON = 'input_error';
export const REFUND_REASON = 'refund';

/** Карточки, из которых покупка допустима (PROCESS 3.5 № 19). */
const PURCHASE_STATES: ReadonlySet<string> = new Set(['agreed', 'callback', 'client']);

export interface WriteWinInput {
  card: CardRef;
  /** Открытая сделка под блокировкой; null — новая сразу выигранной. */
  deal: Pick<DealFullRow, 'id' | 'stageKey'> | null;
  pipeline: DealPipelineInfo;
  wonStageKey: string;
  serviceTypeKey: string;
  amountKzt: number;
  wonAt: number;
  requestId: string;
  at: number;
  settings: DealsSettings;
}

/**
 * Единственный код записи покупки: сделка → won (или новая), событие `deal.won` с id = requestId, передача в отдел
 * по типу услуги. Ключ занят (другая сделка или чужое событие) — `request_reused`, вызывающий откатывает транзакцию.
 */
export async function writeWin(tx: Sql, actor: Actor, w: WriteWinInput): Promise<{ dealId: string; handoffId: string | null; newDeal: boolean }> {
  const me = actorIdOf(actor);
  let dealId: string;
  if (w.deal) {
    if (!(await markDealWon(tx, { id: w.deal.id, stageKey: w.wonStageKey, serviceTypeKey: w.serviceTypeKey, amountKzt: w.amountKzt, wonAt: w.wonAt, at: w.at }))) {
      throw new DealDomainError('deal_closed');
    }
    dealId = w.deal.id;
  } else {
    const id = await insertWonDeal(tx, {
      spaceId: w.card.spaceId,
      pipelineKey: w.pipeline.key,
      stageKey: w.wonStageKey,
      clientId: w.card.clientId,
      cardId: w.card.id,
      ownerUserId: w.card.ownerUserId,
      serviceTypeKey: w.serviceTypeKey,
      amountKzt: w.amountKzt,
      wonAt: w.wonAt,
      requestId: w.requestId,
      createdBy: me,
      at: w.at,
    });
    if (!id) throw new DealDomainError('request_reused');
    dealId = id;
  }
  const written = await insertDealFeedWithId(tx, {
    id: w.requestId,
    clientId: w.card.clientId,
    spaceId: w.card.spaceId,
    dealId,
    kind: 'deal.won',
    actorId: me,
    at: w.at,
    data: { dealId, fromStage: w.deal?.stageKey ?? null, toStage: w.wonStageKey, serviceTypeKey: w.serviceTypeKey, amountKzt: w.amountKzt, wonAt: w.wonAt },
  });
  if (!written) throw new DealDomainError('request_reused');

  const route = w.settings.serviceTypes.find((t) => t.key === w.serviceTypeKey)?.routeToTeam ?? null;
  let handoffId: string | null = null;
  if (route !== null) {
    const h = await createHandoffForDeal(tx, actor, {
      dealId,
      clientId: w.card.clientId,
      spaceId: w.card.spaceId,
      ownerUserId: w.card.ownerUserId,
      teamKey: route,
      serviceTypeKey: w.serviceTypeKey,
      at: w.at,
      settings: w.settings,
    });
    handoffId = h?.handoffId ?? null;
  }
  return { dealId, handoffId, newDeal: w.deal === null };
}

/**
 * Отмена покупки по сделке под блокировкой: `refund` → проигран с причиной `refund`; `error` → прежний открытый этап
 * из ленты `deal.won` (нет его — проигран с `input_error`). Затем передача отменяется. Карточку не трогает.
 */
export async function writeCancel(tx: Sql, actor: Actor, a: { deal: DealFullRow; pipeline: DealPipelineInfo; mode: 'refund' | 'error'; at: number }): Promise<void> {
  const { deal, pipeline, at } = a;
  const lostKey = lostStageOf(pipeline)?.key ?? deal.stageKey;
  let done: boolean;
  if (a.mode === 'refund') {
    done = await markWonDealLost(tx, { id: deal.id, stageKey: lostKey, reasonCode: REFUND_REASON, at });
  } else {
    const prev = await lastWonFromStage(tx, deal.id);
    const stage = prev.fromStage ? pipeline.stages.find((s) => s.key === prev.fromStage && s.kind === 'open') : undefined;
    done = stage
      ? await reopenWonDeal(tx, { id: deal.id, stageKey: stage.key, at })
      : await markWonDealLost(tx, { id: deal.id, stageKey: lostKey, reasonCode: INPUT_ERROR_REASON, at });
  }
  if (!done) throw new DealDomainError('deal_not_won');
  await cancelHandoffOfDeal(tx, actor, { dealId: deal.id, at });
}

function rejectOf(result: { status: string; error?: string }): never {
  throw new CardRejectedError(result.error ?? 'invalid_transition');
}

// ---------------------------------------------------------------------------
// Регистрация покупки
// ---------------------------------------------------------------------------

export const registerPurchase: RegisterPurchase = async (deps, viewer, input) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);

  return inDealsTx(async (tx): Promise<PurchaseResult> => {
    const card = await lockCardScoped(viewer, tx, input.cardId, 'deal.purchase');
    if (!card || card.spaceId !== spaceId) throw new NotFoundError();

    // повтор: событие покупки с этим ключом уже есть — текущее состояние без эффектов
    const seen = await findFeedById(tx, input.requestId);
    if (seen) {
      const dealId = typeof seen.data['dealId'] === 'string' ? seen.data['dealId'] : null;
      if (seen.kind !== 'deal.won' || seen.clientId !== card.clientId || !dealId) throw new DealDomainError('request_reused');
      const row = await lockDealById(tx, dealId);
      if (!row) throw new DealDomainError('request_reused');
      return { deal: toDealView(row, pipelineOf(settings, row.pipelineKey), now), handoffId: await findHandoffIdOfDeal(tx, dealId), replayed: true };
    }

    const service = settings.serviceTypes.find((t) => t.key === input.serviceTypeKey);
    if (!service) throw new DealDomainError('service_type_unknown');
    if (!checkAmount(input.amountKzt)) throw new DealDomainError('amount_invalid');
    const wonAt = purchaseMoment(input.wonDay, settings.timeZone, now, settings.purchaseFutureLimitHours);
    if (wonAt === null) throw new DealDomainError('won_at_invalid');
    if (!PURCHASE_STATES.has(card.state)) throw new DealDomainError('outcome_required');

    let deal: DealFullRow | null = null;
    if (input.dealId !== null) {
      deal = await lockDealScoped(viewer, tx, { dealId: input.dealId, perm: 'deal.purchase', cardId: card.id });
      if (!deal) throw new NotFoundError();
      if (deal.status !== 'open') throw new DealDomainError('deal_closed');
    }
    // Воронка: сделки; для новой — воронка записи (createDealOn: agreed), иначе первая
    const pipeline = deal ? settings.pipelines.find((p) => p.key === deal.pipelineKey) : (settings.pipelines.find((p) => p.createDealOn === 'agreed') ?? settings.pipelines[0]);
    const won = pipeline ? wonStageOf(pipeline) : null;
    if (!pipeline || !won) throw new DealDomainError('invalid_settings');

    const res = await writeWin(tx, viewer, {
      card,
      deal,
      pipeline,
      wonStageKey: won.key,
      serviceTypeKey: service.key,
      amountKzt: input.amountKzt,
      wonAt,
      requestId: input.requestId,
      at: now,
      settings,
    });

    // Событие карточки № 19: карточка → client, задачи по выходу из состояния; эффект win по записанной сделке пуст
    const result = await deps.cards.applyBookingEvent(
      tx,
      viewer,
      card,
      { type: 'purchase', opId: input.requestId, dealId: res.dealId, serviceTypeKey: service.key, amountKzt: input.amountKzt },
      now,
    );
    if (result.status === 'rejected') rejectOf(result);
    // Кэш признаков (pipeline-v2 §5.1): число и дата покупок, горячесть; в той же транзакции, версию карточки не трогает
    await deps.cards.refreshDerived?.(tx, viewer, { spaceId: card.spaceId, clientId: card.clientId });

    if (card.ownerUserId && card.ownerUserId !== viewer.userId) {
      await insertDealNotification(tx, { userId: card.ownerUserId, kind: 'deal_won', dealId: res.dealId, dedupeKey: `deal_won:${res.dealId}:${input.requestId}`, at: now });
    }
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'deal.purchase',
      entity: 'deal',
      entityId: res.dealId,
      spaceId,
      meta: { dealId: res.dealId, serviceTypeKey: service.key, amountKzt: input.amountKzt, newDeal: res.newDeal },
      createdAt: now,
    });
    const row = await lockDealById(tx, res.dealId);
    if (!row) throw new Error('deals: записанная сделка не видна исполнителю');
    return { deal: toDealView(row, pipeline, now), handoffId: res.handoffId, replayed: false };
  });
};

// ---------------------------------------------------------------------------
// Правка и отмена (РОП, deal.move_back)
// ---------------------------------------------------------------------------

/** Карточка → сделка под блокировкой в охвате `perm` (карточку узнаём из сделки в том же охвате). */
async function lockForDeal(viewer: Viewer, tx: Sql, dealId: string, perm: 'deal.move_back' | 'deal.edit', spaceId: string): Promise<{ card: LockedCard; deal: DealFullRow }> {
  const probe = await findDealScoped(viewer, tx, dealId, perm);
  if (!probe || probe.spaceId !== spaceId) throw new NotFoundError();
  const card = await lockCardById(tx, probe.cardId);
  if (!card) throw new NotFoundError();
  const deal = await lockDealScoped(viewer, tx, { dealId, perm });
  if (!deal) throw new NotFoundError();
  return { card, deal };
}

/** Повтор действия: событие с opId уже есть — того же вида по той же сделке → текущее состояние; иначе request_reused. */
async function replayOf(viewer: Viewer, tx: Sql, a: { opId: string; kind: string; dealId: string; settings: DealsSettings; now: number }): Promise<DealView | null> {
  const seen = await findFeedById(tx, a.opId);
  if (!seen) return null;
  if (seen.kind !== a.kind || seen.dealId !== a.dealId) throw new DealDomainError('request_reused');
  const row = await lockDealById(tx, a.dealId);
  if (!row) throw new NotFoundError();
  return toDealView(row, pipelineOf(a.settings, row.pipelineKey), a.now);
}

/** `serviceTypeKey` в правке допустим только прежний: смена типа — `service_type_locked` (D-249). */
export type EditPurchaseRequest = EditPurchaseInput & { serviceTypeKey?: string };

export const editPurchase = (async (deps: DealsDeps, viewer: Viewer, input: EditPurchaseRequest): Promise<DealView> => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  if (input.amountKzt === undefined && input.wonDay === undefined && input.serviceTypeKey === undefined) throw new BadRequestError('empty_patch');
  if (input.amountKzt !== undefined && !checkAmount(input.amountKzt)) throw new DealDomainError('amount_invalid');
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);

  return inDealsTx(async (tx) => {
    const { deal } = await lockForDeal(viewer, tx, input.dealId, 'deal.move_back', spaceId);
    const replay = await replayOf(viewer, tx, { opId: input.opId, kind: 'deal.purchase_edited', dealId: deal.id, settings, now });
    if (replay) return replay;
    if (deal.version !== input.version) throw new ConflictError();
    if (deal.status !== 'won' || deal.wonAt === null) throw new DealDomainError('deal_not_won');
    // Тип услуги меняет маршрут передачи: только отмена «ошибкой» и новая покупка (D-249)
    if (input.serviceTypeKey !== undefined && input.serviceTypeKey !== deal.serviceTypeKey) throw new DealDomainError('service_type_locked');
    const toAmount = input.amountKzt ?? deal.amountKzt;
    let toWonAt = deal.wonAt;
    if (input.wonDay !== undefined) {
      const m = purchaseMoment(input.wonDay, settings.timeZone, now, settings.purchaseFutureLimitHours);
      if (m === null) throw new DealDomainError('won_at_invalid');
      toWonAt = m;
    }
    if (!(await updatePurchaseScoped(viewer, tx, { id: deal.id, version: input.version, amountKzt: toAmount, wonAt: toWonAt, at: now }))) throw new ConflictError();
    const change = { dealId: deal.id, fromAmount: deal.amountKzt, toAmount, fromWonAt: deal.wonAt, toWonAt };
    const written = await insertDealFeedWithId(tx, { id: input.opId, clientId: deal.clientId, spaceId, dealId: deal.id, kind: 'deal.purchase_edited', actorId: viewer.userId, at: now, data: change });
    if (!written) throw new DealDomainError('request_reused');
    await writeAudit(tx, { actorId: viewer.userId, action: 'deal.purchase_edit', entity: 'deal', entityId: deal.id, spaceId, meta: change, createdAt: now });
    if (toWonAt !== deal.wonAt) await deps.cards.refreshDerived?.(tx, viewer, { spaceId, clientId: deal.clientId });
    const row = await lockDealById(tx, deal.id);
    if (!row) throw new NotFoundError();
    return toDealView(row, pipelineOf(settings, row.pipelineKey), now);
  });
}) satisfies EditPurchase;

export const cancelPurchase: CancelPurchase = async (deps, viewer, input) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const comment = input.comment.trim();
  if (comment === '' || comment.length > COMMENT_MAX) throw new BadRequestError('comment');
  if (input.mode !== 'refund' && input.mode !== 'error') throw new BadRequestError('mode');
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);

  return inDealsTx(async (tx) => {
    const { card, deal } = await lockForDeal(viewer, tx, input.dealId, 'deal.move_back', spaceId);
    const replay = await replayOf(viewer, tx, { opId: input.opId, kind: 'deal.purchase_cancelled', dealId: deal.id, settings, now });
    if (replay) return replay;
    if (deal.version !== input.version) throw new ConflictError();
    if (deal.status !== 'won') throw new DealDomainError('deal_not_won');

    await writeCancel(tx, viewer, { deal, pipeline: pipelineOf(settings, deal.pipelineKey), mode: input.mode, at: now });
    await insertDealNote(tx, { clientId: deal.clientId, spaceId, dealId: deal.id, authorId: viewer.userId, body: comment, at: now });
    const written = await insertDealFeedWithId(tx, {
      id: input.opId,
      clientId: deal.clientId,
      spaceId,
      dealId: deal.id,
      kind: 'deal.purchase_cancelled',
      actorId: viewer.userId,
      at: now,
      data: { dealId: deal.id, mode: input.mode },
    });
    if (!written) throw new DealDomainError('request_reused');
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'deal.purchase_cancel',
      entity: 'deal',
      entityId: deal.id,
      spaceId,
      meta: { dealId: deal.id, mode: input.mode, amountKzt: deal.amountKzt, serviceTypeKey: deal.serviceTypeKey },
      createdAt: now,
    });

    // Карточка (№ 20): у клиента другая покупка — остаётся «Клиент» (D-249); иначе → «Договорились» или «Перезвон»
    const otherWon = await hasOtherDeal(tx, { spaceId, clientId: deal.clientId, status: 'won', exceptId: deal.id });
    if (!otherWon && card.state === 'client') {
      const hasOtherOpenDeal = await hasOtherDeal(tx, { spaceId, clientId: deal.clientId, status: 'open', exceptId: null });
      const result = await deps.cards.applyBookingEvent(tx, viewer, card, { type: 'purchase_cancelled', opId: input.opId, dealId: deal.id, comment, facts: { hasOtherOpenDeal } }, now);
      if (result.status === 'rejected') rejectOf(result);
    }
    // Кэш признаков пересчитывается при любом состоянии карточки (у «Клиента» с другой покупкой счётчик тоже меняется)
    await deps.cards.refreshDerived?.(tx, viewer, { spaceId, clientId: deal.clientId });
    const row = await lockDealById(tx, deal.id);
    if (!row) throw new NotFoundError();
    return toDealView(row, pipelineOf(settings, row.pipelineKey), now);
  });
};
