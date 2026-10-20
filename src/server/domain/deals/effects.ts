// Что запись делает со сделкой (B2, D-134): открыть при записи, сдвинуть вперёд при явке, и исполнитель
// эффектов `calling.DealEffect` для C5. Операции покупки и передачи (`win`, `lose`, `lose_open`,
// `cancel_purchase`, `reassign_open`) — B6/B9a: пока их порождают другие пути, здесь они бросают.
import type { calling } from '@crm/core';
import type { BookingActor, DealLink, DealStages, LockedCard } from '@/server/domain/booking/types';
import type { Sql } from '@/server/platform/db';
import { bookingPipeline, configPipelineResolver, toDealStages, type PipelineResolver } from './pipelines';
import { dealIdOfBooking, findDealById, findDealByRequestId, findOpenDealId, insertDeal, insertDealFeed, loseDeal, setDealStage, setNeedsRebook } from './repo';

type CardRef = Pick<LockedCard, 'id' | 'clientId' | 'spaceId' | 'ownerUserId'>;

const actorId = (a: BookingActor): string | null => (a.kind === 'user' ? a.userId : null);

async function ensureOpenFor(sql: Sql, actor: BookingActor, card: CardRef, args: { requestId: string; at: number; stages: DealStages | null }): Promise<string | null> {
  const { stages } = args;
  if (!stages) return null;
  // Повтор того же запроса — та же сделка (идемпотентность по ключу, D-132).
  const byRequest = await findDealByRequestId(sql, args.requestId);
  if (byRequest) {
    if (byRequest.cardId !== card.id) throw new Error('deals: ключ запроса принадлежит сделке другой карточки');
    return byRequest.id;
  }
  const open = await findOpenDealId(sql, card.id, stages.pipelineKey);
  if (open) return open;
  if (!stages.onAgreedStageKey) return null;
  const id = await insertDeal(sql, {
    spaceId: card.spaceId,
    pipelineKey: stages.pipelineKey,
    stageKey: stages.onAgreedStageKey,
    clientId: card.clientId,
    cardId: card.id,
    ownerUserId: card.ownerUserId,
    requestId: args.requestId,
    createdBy: actorId(actor),
    at: args.at,
  });
  if (!id) return (await findDealByRequestId(sql, args.requestId))?.id ?? null;
  await insertDealFeed(sql, {
    clientId: card.clientId,
    spaceId: card.spaceId,
    dealId: id,
    kind: 'deal.created',
    actorId: actorId(actor),
    at: args.at,
    data: { dealId: id, pipelineKey: stages.pipelineKey, stageKey: stages.onAgreedStageKey },
  });
  return id;
}

async function advanceFor(
  sql: Sql,
  actor: BookingActor,
  resolve: PipelineResolver,
  args: { dealId: string; bookingId: string; at: number; stages: DealStages | null },
): Promise<void> {
  const to = args.stages?.onAttendedStageKey;
  if (!args.stages || !to) return;
  const deal = await findDealById(sql, args.dealId);
  if (!deal || deal.status !== 'open' || deal.pipelineKey !== args.stages.pipelineKey) return;
  const pipeline = (await resolve(deal.spaceId)).find((p) => p.key === deal.pipelineKey);
  const target = pipeline?.stages.find((s) => s.key === to);
  if (!pipeline || !target || target.kind !== 'open') return;
  const current = pipeline.stages.find((s) => s.key === deal.stageKey);
  // Только вперёд (PROCESS 4.2): сделка, уже ушедшая дальше «Пришёл», назад не возвращается.
  if (current && current.order >= target.order) return;
  await setDealStage(sql, deal.id, target.key, args.at);
  await insertDealFeed(sql, {
    clientId: deal.clientId,
    spaceId: deal.spaceId,
    dealId: deal.id,
    kind: 'deal.stage',
    actorId: actorId(actor),
    at: args.at,
    data: { dealId: deal.id, from: deal.stageKey, to: target.key, cause: 'attended', bookingId: args.bookingId },
  });
}

/** Связка записи со сделкой (порт `DealLink`); этапы воронки читает `resolve` (по умолчанию — активные настройки). */
export function createDealLink(resolve: PipelineResolver = configPipelineResolver): DealLink {
  return {
    ensureOpen: (sql, actor, card, args) => ensureOpenFor(sql, actor, card, args),
    advanceOnAttended: (sql, actor, args) => advanceFor(sql, actor, resolve, args),
  };
}

export const dealLink: DealLink = createDealLink();

/** Этапы воронки записи пространства: null, если сделку запись не создаёт. */
async function stagesOf(resolve: PipelineResolver, spaceId: string): Promise<DealStages | null> {
  const p = bookingPipeline(await resolve(spaceId));
  return p ? toDealStages(p) : null;
}

/**
 * Исполнитель `effects.deals` машины карточки (C5). Карточка заблокирована вызывающим. Операции, которым
 * нужны покупки и передача, — B6/B9a.
 */
export async function applyDealEffects(
  sql: Sql,
  actor: BookingActor,
  card: CardRef,
  effects: readonly calling.DealEffect[],
  at: number,
  opts: { resolve?: PipelineResolver } = {},
): Promise<void> {
  const resolve = opts.resolve ?? configPipelineResolver;
  for (const e of effects) {
    switch (e.op) {
      case 'ensure_open':
        await ensureOpenFor(sql, actor, card, { requestId: e.requestId, at, stages: await stagesOf(resolve, card.spaceId) });
        break;
      case 'advance': {
        const dealId = await dealIdOfBooking(sql, e.bookingId);
        if (dealId) await advanceFor(sql, actor, resolve, { dealId, bookingId: e.bookingId, at, stages: await stagesOf(resolve, card.spaceId) });
        break;
      }
      case 'set_needs_rebook':
        await setNeedsRebook(sql, e.bookingId, e.value, at);
        break;
      case 'lose_created_by': {
        const deal = await findDealByRequestId(sql, e.opId);
        if (!deal || deal.status !== 'open') break;
        const pipeline = (await resolve(deal.spaceId)).find((p) => p.key === deal.pipelineKey);
        const lostStage = pipeline?.stages.find((s) => s.kind === 'lost')?.key ?? deal.stageKey;
        await loseDeal(sql, deal.id, { stageKey: lostStage, reasonCode: e.reasonCode, at });
        await insertDealFeed(sql, {
          clientId: deal.clientId,
          spaceId: deal.spaceId,
          dealId: deal.id,
          kind: 'deal.lost',
          actorId: actorId(actor),
          at,
          data: { dealId: deal.id, reasonCode: e.reasonCode },
        });
        break;
      }
      default:
        throw new Error(`deals: операция ${e.op} появится в B6/B9a`);
    }
  }
}
