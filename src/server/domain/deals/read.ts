// Чтение сделок (B6, docs/deals-handoffs-design.md §5.9): страница сделки и форма покупки по карточке.
// Чужое = несуществующее (404); кнопки `can` — подсказка интерфейсу, сервер проверяет каждое действие.
import { NotFoundError } from '@/server/access';
import { toBookingView } from '@/server/domain/booking/repo';
import { getDb } from '@/server/platform/db';
import { requirePurchases, requireSpace } from './guards';
import type { DealFullRow } from './repo.purchase';
import { findCardForPurchase, findDealHandoff, findDealPageRow, listDealBookings, listDealHistory, listOpenDealsOfCard } from './repo.read';
import { staleDaysOf } from './rules';
import { seesDealsOnlyAsDepartment, withoutMoney } from './visibility';
import { DealDomainError } from './errors';
import type { DealHistoryItem, DealPipelineInfo, DealView, DealsSettings, GetDealPage, GetPurchaseForm } from './types';

/**
 * Строка сделки → проекция (без ПДн: текст причины проигрыша и поля сделки не входят). `hideMoney` — зритель видит
 * сделку только как отдел передачи (D-300): суммы нет.
 */
export function toDealView(r: DealFullRow, pipeline: DealPipelineInfo | undefined, now: number, opts: { hideMoney?: boolean } = {}): DealView {
  const stage = pipeline?.stages.find((s) => s.key === r.stageKey);
  return {
    id: r.id,
    pipelineKey: r.pipelineKey,
    stageKey: r.stageKey,
    status: r.status,
    clientId: r.clientId,
    cardId: r.cardId,
    ownerUserId: r.ownerUserId,
    serviceTypeKey: r.serviceTypeKey,
    amountKzt: opts.hideMoney ? null : r.amountKzt,
    wonAt: r.wonAt,
    lostAt: r.lostAt,
    lostReasonCode: r.lostReasonCode,
    needsRebook: r.needsRebook,
    stageChangedAt: r.stageChangedAt,
    staleDays: staleDaysOf({ status: r.status, stageChangedAt: r.stageChangedAt }, stage, now),
    version: r.version,
    createdAt: r.createdAt,
  };
}

/** Воронка сделки из настроек; удалённая из настроек воронка — минимальная (этапы неизвестны, показываем ключ). */
export function pipelineOf(settings: DealsSettings, key: string): DealPipelineInfo {
  return settings.pipelines.find((p) => p.key === key) ?? { key, label: { ru: key }, createDealOn: 'manual', stages: [] };
}

/**
 * История: у событий сделки и передачи — коды и числа; у остальных (заметка, запись) — только вид и время.
 * `hideMoney` — без денежных ключей (отдел передачи, D-300).
 */
function toHistoryItem(r: { id: string; kind: string; at: number; actorName: string | null; data: Record<string, unknown> }, hideMoney: boolean): DealHistoryItem {
  const own = r.kind.startsWith('deal.') || r.kind.startsWith('handoff.');
  let data: Record<string, unknown> = {};
  if (own) for (const [k, v] of Object.entries(r.data ?? {})) if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') data[k] = v;
  if (hideMoney) data = withoutMoney(data);
  return { id: r.id, kind: r.kind, at: r.at, actorName: r.actorName, data };
}

export const getDealPage: GetDealPage = async (deps, viewer, dealId) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const db = await getDb();
  // Отдел передачи: только сделка передачи и без денег (D-300)
  const hideMoney = seesDealsOnlyAsDepartment(viewer);
  const row = await findDealPageRow(viewer, db.sql, dealId, hideMoney);
  if (!row || row.spaceId !== spaceId) throw new NotFoundError();
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const pipeline = pipelineOf(settings, row.pipelineKey);
  const [history, bookings, handoff] = await Promise.all([listDealHistory(viewer, db.sql, row.id), listDealBookings(viewer, db.sql, row.id), findDealHandoff(db.sql, row.id)]);
  const open = row.status === 'open';
  return {
    deal: toDealView(row, pipeline, now, { hideMoney }),
    clientName: row.clientName,
    ownerName: row.ownerName,
    pipeline,
    history: history.map((h) => toHistoryItem(h, hideMoney)),
    bookings: bookings.map(toBookingView),
    handoff,
    can: {
      purchase: open && row.canPurchase,
      editStage: open && row.canEdit,
      moveBack: open && row.canEdit && row.canMoveBack,
      lose: open && row.canEdit,
      editPurchase: row.status === 'won' && row.canMoveBack,
    },
  };
};

const PURCHASE_STATES: ReadonlySet<string> = new Set(['agreed', 'callback', 'client']);

export const getPurchaseForm: GetPurchaseForm = async (deps, viewer, input) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const db = await getDb();
  const card = await findCardForPurchase(viewer, db.sql, input.cardId);
  if (!card || card.spaceId !== spaceId) throw new NotFoundError();
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const open = await listOpenDealsOfCard(viewer, db.sql, card.id);
  // По умолчанию — единственная открытая сделка воронки записи (createDealOn: agreed); иначе «Новая сделка»
  const bookingPipelineKey = settings.pipelines.find((p) => p.createDealOn === 'agreed')?.key ?? null;
  const inBooking = open.filter((d) => d.pipelineKey === bookingPipelineKey);
  const lang = input.locale === 'kk' ? 'kk' : 'ru';
  if (settings.pipelines.length === 0) throw new DealDomainError('invalid_settings');
  return {
    cardId: card.id,
    clientId: card.clientId,
    clientName: card.clientName,
    cardState: card.state,
    allowed: PURCHASE_STATES.has(card.state),
    openDeals: open.map((d) => ({ id: d.id, stageKey: d.stageKey, version: d.version, createdAt: d.createdAt })),
    defaultDealId: inBooking.length === 1 ? inBooking[0]!.id : null,
    serviceTypes: settings.serviceTypes.map((t) => ({ key: t.key, label: (lang === 'kk' ? t.label.kk : undefined) ?? t.label.ru, routesToTeam: t.routeToTeam !== null })),
    today: settings.calendar.localDay(now),
    timeZone: settings.timeZone,
  };
};
