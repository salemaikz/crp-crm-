// Итог звонка (docs/calls-design.md §4): идемпотентность по opId, блокировка карточки, `calling.applyOutcome`,
// запись перехода, «Договорились — записать» одной транзакцией. Охват: чужая и несуществующая карточка — 404.
import { calling } from '@crm/core';
import { NotFoundError } from '@/server/access';
import { createBooking } from '@/server/domain/booking/bookings';
import { findBookingByRequestId, toBookingView } from '@/server/domain/booking/repo';
import { toCoreActor } from '@/server/domain/cards/actor';
import { persistTransition } from '@/server/domain/cards/persist';
import { findPriorCall, lockCardScoped, lockCardUnscoped, wasEverAssignedTo, wasOwnerAt, type PriorCallRow } from '@/server/domain/cards/repo';
import type { CallExtras, LockedCardRow, OutcomeConfig } from '@/server/domain/cards/types';
import { CallsDomainError } from './errors';
import { assertFieldKeysAllowed, loadFieldsConfig, validateOutcomeFields, writeOutcomeFields, type FieldWrite } from './fields';
import { getDb } from '@/server/platform/db';
import { inCallsTx } from './tx';
import type { BookingView } from '@/server/domain/booking/types';
import type { OutcomeCardView, OutcomeRequest, OutcomeResponse, SubmitOutcome } from './types';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
/** Заглушка bookingId для первого прогона ядра «Договорились — записать» (§4.3). */
const PENDING_BOOKING = '__pending__';

const view = (c: calling.CardSnapshot): OutcomeCardView => ({ id: c.id, state: c.state, version: c.version, nextCallAt: c.nextCallAt });

function reject(r: calling.RejectedResult): never {
  throw new CallsDomainError(r.error, r.field);
}

function lprInfoFilled(i: OutcomeRequest['lprInfo']): boolean {
  return i !== null && [i.name, i.phone, i.when].some((x) => x.trim() !== '');
}

function buildEvent(req: OutcomeRequest, receivedAt: number, wasOwner: boolean, bookingId: string | null): calling.OutcomeEvent {
  return {
    type: 'outcome',
    opId: req.opId,
    outcomeKey: req.outcomeKey,
    via: req.via,
    occurredAt: req.occurredAt,
    receivedAt,
    phoneId: req.phoneId,
    reasonCode: req.reasonCode,
    hasNote: req.note.trim() !== '',
    lpr: req.lpr,
    lprInfoFilled: lprInfoFilled(req.lprInfo),
    callbackAt: req.callbackAt,
    markTarget: req.markTarget,
    alsoDncPhoneIds: req.alsoDncPhoneIds,
    agreement: req.agreement ? { contactId: req.agreement.contactId, bookingId, agreedDueAt: req.agreement.agreedDueAt } : null,
    seenVersion: null,
    facts: { sameOpId: null, actorWasOwnerAtCall: wasOwner },
  };
}

function assertPhonesOnCard(req: OutcomeRequest, row: LockedCardRow): void {
  const ids = new Set(row.snapshot.phones.map((p) => p.id));
  if (req.phoneId !== null && !ids.has(req.phoneId)) throw new CallsDomainError('phone_not_on_card', 'phoneId');
  if (req.alsoDncPhoneIds.some((id) => !ids.has(id))) throw new CallsDomainError('phone_not_on_card', 'alsoDncPhoneIds');
}

/**
 * Повтор итога «Договорились — записать» (ответ потерялся, мастер повторил тот же opId): запись уже есть, её ключ — opId.
 * Отдаём её целиком, чтобы мастер закончил как после первого запроса. Чужую запись (другая карточка или чужой итог) не показываем.
 */
async function withReplayedBooking(response: OutcomeResponse, req: OutcomeRequest, userId: string): Promise<OutcomeResponse> {
  const row = await findBookingByRequestId((await getDb()).sql, req.opId);
  if (!row || row.cardId !== req.cardId) return response;
  // Автор итога — по calls.opId (как ownPrior): при переносе автор записи остаётся прежним (bookedByUserId), а итог мой
  const prior = await findPriorCall((await getDb()).sql, req.opId);
  if (!prior || prior.userId !== userId || prior.cardId !== req.cardId) return response;
  return { ...response, bookingId: row.id, booking: toBookingView(row), bookingAction: row.movedFromId ? 'moved' : 'created' };
}

export const submitOutcome: SubmitOutcome = async (deps, viewer, req) => {
  const spaceId = viewer.spaceId;
  if (spaceId === null) throw new NotFoundError();
  const receivedAt = deps.now();
  const ctx = await deps.context(spaceId, receivedAt);

  // Проверки, не требующие карточки
  const def: OutcomeConfig | undefined = ctx.outcomes.find((o) => o.key === req.outcomeKey);
  if (!def) throw new CallsDomainError('outcome_unknown', 'outcomeKey');
  assertFieldKeysAllowed(def, req.fields);
  if ((def.kind === 'do_not_call' || def.kind === 'bad_number') && req.phoneId === null) throw new CallsDomainError('phone_required', 'phoneId');
  const fieldsCfg = await loadFieldsConfig(viewer, def, req.fields);

  const offlineMs = ctx.settings.offlineWindowHours * HOUR_MS;
  const t = Math.min(Math.max(req.occurredAt, receivedAt - offlineMs), receivedAt + calling.OCCURRED_FUTURE_TOLERANCE_MS);

  const duplicateOf = (prior: PriorCallRow, card: OutcomeCardView | null): OutcomeResponse => ({
    status: 'duplicate',
    applied: prior.applied,
    factReason: prior.factReason,
    warnings: [],
    card,
    bookingId: null,
    booking: null,
    bookingAction: null,
  });
  /** Свой прошлый звонок с этим opId (тот же сотрудник и та же карточка): повтор ответа, не новая запись. */
  const ownPrior = async (tx: Parameters<typeof findPriorCall>[0]): Promise<PriorCallRow | null> => {
    const p = await findPriorCall(tx, req.opId);
    return p && p.userId === viewer.userId && p.cardId === req.cardId ? p : null;
  };

  const response = await inCallsTx(async (tx) => {
    // --- блокировка: карточка первой ---
    let row = await lockCardScoped(tx, viewer, req.cardId, 'card.outcome');
    let wasOwner = false;
    if (!row) {
      // Свой уже записанный итог — duplicate до проверки владения (D-223): ответ потерялся, карточку передали,
      // устройство повторило позже окна — время сдвинуто, «был владельцем» уже не доказать, а запись есть.
      // Запись в calls неизменна, поэтому блокировка карточки для этого ответа не нужна; данных карточки нет.
      const early = await ownPrior(tx);
      if (early) return duplicateOf(early, null);
      // Карточку передали после звонка: итог пишется фактом (D-175), всё остальное — как несуществующая
      // Блокировка без охвата — только если карточка когда-либо была за сотрудником: чужие не блокируем
      if (!(await wasEverAssignedTo(tx, { cardId: req.cardId, userId: viewer.userId }))) throw new CallsDomainError('not_found');
      row = await lockCardUnscoped(tx, req.cardId);
      if (!row || row.spaceId !== spaceId) throw new CallsDomainError('not_found');
      // Параллельный первый запрос мог записать звонок, пока ждали блокировку
      const locked = await ownPrior(tx);
      if (locked) return duplicateOf(locked, null);
      if (!(await wasOwnerAt(tx, { cardId: req.cardId, userId: viewer.userId, at: t }))) throw new CallsDomainError('not_found');
      wasOwner = true;
    }

    // --- повтор opId: после блокировки ---
    const prior = await findPriorCall(tx, req.opId);
    if (prior) {
      if (prior.userId !== viewer.userId || prior.cardId !== req.cardId) throw new CallsDomainError('opid_reused');
      return duplicateOf(prior, wasOwner ? null : view(row.snapshot));
    }

    assertPhonesOnCard(req, row);
    const writes: FieldWrite[] = fieldsCfg ? await validateOutcomeFields(tx, viewer, fieldsCfg, def, { id: row.snapshot.id, clientId: row.snapshot.clientId }, req.fields, req.outcomeKey) : [];

    // Карточка вне охвата сотрудника (передана после звонка, D-175): ядро должно дать только факт owner_changed.
    // Охват team/space/all ядро видит как space и применило бы итог к чужой карточке (сделки, состояние), поэтому
    // в этой ветке исполнитель для ядра всегда own (D-224). relation остаётся relation — ядро откажет.
    const baseActor = toCoreActor(viewer);
    const coreActor: calling.Actor = wasOwner && baseActor.scope === 'space' ? { ...baseActor, scope: 'own' } : baseActor;
    const run = (bookingId: string | null) =>
      calling.applyOutcome({
        card: row.snapshot,
        event: buildEvent(req, receivedAt, wasOwner, bookingId),
        actor: coreActor,
        now: receivedAt,
        settings: ctx.settings,
        calendar: ctx.calendar,
      });

    const wantsBooking = req.agreement?.booking != null;
    let result = run(wantsBooking ? PENDING_BOOKING : null);
    if (result.status === 'rejected') reject(result);
    if (result.status === 'duplicate') throw new Error('calls: ядро ответило duplicate без sameOpId');

    // --- «Договорились — записать»: запись в той же транзакции, только если итог применён (§4.3) ---
    let bookingId: string | null = null;
    let booking: BookingView | null = null;
    let bookingAction: 'created' | 'moved' | null = null;
    if (wantsBooking && result.status === 'applied' && req.agreement?.booking) {
      const created = await createBooking(
        deps.booking(),
        viewer,
        { ...req.agreement.booking, requestId: req.opId, clientId: row.snapshot.clientId, contactId: req.agreement.contactId } as Parameters<typeof createBooking>[2],
        { tx, fromOutcome: { opId: req.opId } },
      );
      bookingId = created.booking.id;
      booking = created.booking;
      bookingAction = created.action;
      result = run(bookingId);
      if (result.status === 'rejected') reject(result);
      if (result.status === 'duplicate') throw new Error('calls: ядро ответило duplicate без sameOpId');
    }

    const extras: CallExtras = {
      note: req.note,
      fieldsPatch: req.lprInfo ? { ...req.fields, lpr: req.lprInfo } : { ...req.fields },
      tappedAt: req.tappedAt,
      durationSec: req.durationSec,
      durationSource: req.durationSec !== null ? 'manual_estimate' : 'none',
    };
    await persistTransition(tx, viewer, { ctx, before: row, result, call: extras, at: receivedAt });
    if (result.status === 'applied' && writes.length > 0) {
      await writeOutcomeFields(tx, viewer, { id: row.snapshot.id, clientId: row.snapshot.clientId, spaceId: row.spaceId }, writes, receivedAt);
    }

    const factReason: calling.FactReason = result.status === 'fact_only' ? result.factReason : '';
    return {
      status: result.status,
      applied: result.status,
      factReason,
      warnings: result.warnings,
      // Передана другому: карточка оператору больше не видна
      card: factReason === 'owner_changed' ? null : view(result.card),
      bookingId,
      booking,
      bookingAction,
    } satisfies OutcomeResponse;
  });
  return response.status === 'duplicate' && req.agreement?.booking ? withReplayedBooking(response, req, viewer.userId) : response;
};
