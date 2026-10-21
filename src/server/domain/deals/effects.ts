// Что запись делает со сделкой (B2, D-134): открыть при записи, сдвинуть вперёд при явке, и исполнитель
// эффектов `calling.DealEffect` для C5. Покупку, её отмену и проигрыш сервис сделок пишет сам ДО события
// карточки (D-248), поэтому `win`, `cancel_purchase`, `lose` по уже записанной сделке — пустые операции
// (docs/deals-handoffs-design.md §5.8). `reassign_open` — B9a: здесь бросает.
import type { calling } from '@crm/core';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import { throwNotFoundOrConflict } from '@/server/access/scope';
import type { BookingActor, DealLink, DealStages, LockedCard } from '@/server/domain/booking/types';
import type { Sql } from '@/server/platform/db';
import { bookingPipeline, configPipelineResolver, toDealStages, type PipelineResolver } from './pipelines';
import { findFeedById, findDealByRequest, lockDealById, type DealFullRow } from './repo.purchase';
import { writeCancel, writeWin } from './purchase';
import { pipelineOf } from './read';
import { wonStageOf } from './rules';
import { loadDealsSettings } from './settings';
import type { LoadDealsSettings } from './types';
import { dealIdOfBooking, findDealById, findDealByRequestId, findOpenDealId, insertDeal, insertDealFeed, listOpenDealsOfClient, lockDealForStage, loseDeal, setDealStage, setNeedsRebook, updateDealStageScoped, type DealRow } from './repo';

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

/** Ручной перевод сделки на этап (итог встречи консультанта): только открытые этапы, назад — по праву `deal.move_back`. */
async function moveToStageFor(
  sql: Sql,
  viewer: Viewer,
  resolve: PipelineResolver,
  args: { dealId: string; version: number; toStageKey: string; bookingId: string; at: number },
): Promise<'moved' | 'same'> {
  const deal = await lockDealForStage(viewer, sql, args.dealId);
  if (!deal) throw new NotFoundError();
  if (deal.version !== args.version) throw new ConflictError();
  if (deal.status !== 'open') throw new ConflictError();
  const pipeline = (await resolve(deal.spaceId)).find((p) => p.key === deal.pipelineKey);
  const target = pipeline?.stages.find((s) => s.key === args.toStageKey);
  if (!pipeline || !target) throw new BadRequestError('stage_unknown');
  if (target.kind === 'won') throw new BadRequestError('use_purchase');
  if (target.kind === 'lost') throw new BadRequestError('use_lose');
  const current = pipeline.stages.find((s) => s.key === deal.stageKey);
  if (current && current.key === target.key) return 'same';
  if (current && current.order > target.order && scopeOf(viewer, 'deal.move_back') === null) throw new ForbiddenError();
  const ok = await updateDealStageScoped(viewer, sql, { id: deal.id, version: args.version, stageKey: target.key, at: args.at });
  if (!ok) await throwNotFoundOrConflict(viewer, sql, 'deal', deal.id);
  await insertDealFeed(sql, {
    clientId: deal.clientId,
    spaceId: deal.spaceId,
    dealId: deal.id,
    kind: 'deal.stage',
    actorId: viewer.userId,
    at: args.at,
    data: { dealId: deal.id, from: deal.stageKey, to: target.key, cause: 'manual', bookingId: args.bookingId },
  });
  return 'moved';
}

/** Связка записи со сделкой (порт `DealLink`); этапы воронки читает `resolve` (по умолчанию — активные настройки). */
export function createDealLink(resolve: PipelineResolver = configPipelineResolver): DealLink {
  return {
    ensureOpen: (sql, actor, card, args) => ensureOpenFor(sql, actor, card, args),
    advanceOnAttended: (sql, actor, args) => advanceFor(sql, actor, resolve, args),
    moveToStage: (sql, viewer, args) => moveToStageFor(sql, viewer, resolve, args),
    laterOpenStages: async (spaceId, pipelineKey, fromStageKey) => {
      const pipeline = (await resolve(spaceId)).find((p) => p.key === pipelineKey);
      const current = pipeline?.stages.find((s) => s.key === fromStageKey);
      if (!pipeline || !current) return [];
      return pipeline.stages.filter((s) => s.kind === 'open' && s.order > current.order).map((s) => ({ key: s.key, label: s.label ?? null }));
    },
  };
}

export const dealLink: DealLink = createDealLink();

/** Этапы воронки записи пространства: null, если сделку запись не создаёт. */
async function stagesOf(resolve: PipelineResolver, spaceId: string): Promise<DealStages | null> {
  const p = bookingPipeline(await resolve(spaceId));
  return p ? toDealStages(p) : null;
}

/** Закрыть открытую сделку проигрышем: этап «проигран» воронки (нет такого — прежний), событие ленты. */
async function loseOne(sql: Sql, actor: BookingActor, resolve: PipelineResolver, deal: DealRow, reasonCode: string, at: number): Promise<void> {
  if (deal.status !== 'open') return;
  const pipeline = (await resolve(deal.spaceId)).find((p) => p.key === deal.pipelineKey);
  const lostStage = pipeline?.stages.find((s) => s.kind === 'lost')?.key ?? deal.stageKey;
  await loseDeal(sql, deal.id, { stageKey: lostStage, reasonCode, at });
  await insertDealFeed(sql, {
    clientId: deal.clientId,
    spaceId: deal.spaceId,
    dealId: deal.id,
    kind: 'deal.lost',
    actorId: actorId(actor),
    at,
    data: { dealId: deal.id, reasonCode },
  });
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
  opts: { resolve?: PipelineResolver; settings?: LoadDealsSettings } = {},
): Promise<void> {
  const resolve = opts.resolve ?? configPipelineResolver;
  const settingsOf = opts.settings ?? loadDealsSettings;
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
        if (deal) await loseOne(sql, actor, resolve, deal, e.reasonCode, at);
        break;
      }
      case 'lose_open': {
        // PROCESS 4.1: отказ закрывает ВСЕ открытые сделки клиента проигрышем с той же причиной; нет открытых — ничего
        for (const deal of await listOpenDealsOfClient(sql, card.spaceId, card.clientId)) await loseOne(sql, actor, resolve, deal, e.reasonCode, at);
        break;
      }
      case 'win':
        await winEffect(sql, actor, card, e, at, settingsOf);
        break;
      case 'cancel_purchase': {
        // Сервис уже отменил покупку → сделка не `won` → ничего; иначе — как «возврат» (§5.5)
        const deal = await lockDealById(sql, e.dealId);
        if (deal && deal.status === 'won') {
          const settings = await settingsOf(deal.spaceId, at);
          await writeCancel(sql, actor, { deal, pipeline: pipelineOf(settings, deal.pipelineKey), mode: 'refund', at });
        }
        break;
      }
      case 'lose': {
        const deal = await findDealById(sql, e.dealId);
        if (deal && deal.status === 'open') await loseOne(sql, actor, resolve, deal, e.reasonCode, at);
        break;
      }
      default:
        throw new Error(`deals: операция ${e.op} появится в B9a`);
    }
  }
}

/**
 * `win` (§5.8): покупка с этим ключом уже записана сервисом → ничего; открытая сделка → полная покупка с `won_at = at`;
 * `dealId = null` и сделки с ключом нет → новая выигранная; проигранная — ошибка сборки (так ядро не порождает).
 */
async function winEffect(
  sql: Sql,
  actor: BookingActor,
  card: CardRef,
  e: Extract<calling.DealEffect, { op: 'win' }>,
  at: number,
  settingsOf: LoadDealsSettings,
): Promise<void> {
  const seen = await findFeedById(sql, e.requestId);
  if (seen && seen.kind === 'deal.won') return;
  let deal: DealFullRow | null = null;
  if (e.dealId !== null) {
    deal = await lockDealById(sql, e.dealId);
    if (!deal) throw new Error('deals: сделки эффекта win нет');
    if (deal.status === 'won') return;
    if (deal.status === 'lost') throw new Error('deals: эффект win по проигранной сделке');
  } else if (await findDealByRequest(sql, e.requestId)) {
    return;
  }
  const settings = await settingsOf(card.spaceId, at);
  const pipeline = deal ? pipelineOf(settings, deal.pipelineKey) : (settings.pipelines.find((p) => p.createDealOn === 'agreed') ?? settings.pipelines[0]);
  const won = pipeline ? wonStageOf(pipeline) : null;
  if (!pipeline || !won) throw new Error('deals: у воронки нет этапа покупки');
  await writeWin(sql, actor, {
    card,
    deal,
    pipeline,
    wonStageKey: won.key,
    serviceTypeKey: e.serviceTypeKey,
    amountKzt: e.amountKzt,
    wonAt: at,
    requestId: e.requestId,
    at,
    settings,
  });
}
