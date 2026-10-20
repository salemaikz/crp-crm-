// «Мои консультации» и итог встречи (B5c, docs/deals-handoffs-design.md §4.9, D-246).
// Список строится от ресурса зрителя без охвата записей (исключение D-246): строка нужна консультанту до того,
// как клиент открылся; клиент отдаётся только внутри окна доступа (`scopeSql('client')`), иначе поля клиента пусты.
import { booking as core } from '@crm/core';
import { BadRequestError, scopeOf, type Viewer } from '@/server/access';
import { throwNotFoundOrConflict } from '@/server/access/scope';
import { newId } from '@/server/platform/db';
import type { MyConsultation, RecordConsultResult, ListMyConsultations } from './consultTypes';
import { BookingDomainError } from './errors';
import { requireSpace } from './guards';
import { findBooking, lockCardOfBooking, toBookingView } from './repo';
import {
  clientNameOf,
  findDealBrief,
  findFeedById,
  insertFeedWithId,
  insertManualTask,
  insertNote,
  insertNoteFeed,
  isMyResourceBooking,
  listMyConsultationRows,
  resourceUserOf,
} from './repo.consult';
import { inBookingTx } from './tx';
import type { BookingDeps, BookingView, LocalizedLabel } from './types';

const MAX_RANGE_DAYS = 62;
export const NOTE_MAX = 2000;

const notFound = () => new BookingDomainError('booking_not_found');

export const listMyConsultations: ListMyConsultations = async (_deps, viewer, input) => {
  const spaceId = requireSpace(viewer);
  if (!core.isLocalDate(input.from) || !core.isLocalDate(input.to) || input.from > input.to || core.addDays(input.from, MAX_RANGE_DAYS) < input.to) {
    throw new BadRequestError('window');
  }
  const rows = await inBookingTx({}, (tx) => listMyConsultationRows(viewer, tx, { spaceId, from: input.from, to: input.to }));
  return rows.map(
    (r): MyConsultation => ({
      bookingId: r.id,
      bookingDate: r.bookingDate,
      startTime: r.startTime,
      durationMin: r.durationMin,
      status: r.status,
      directionKey: r.directionKey,
      isReserve: r.isReserve,
      version: r.version,
      inWindow: r.inWindow,
      // Вне окна клиент закрыт: ни имени, ни id, ни сделки
      clientId: r.inWindow ? r.clientId : null,
      cardId: r.inWindow ? r.cardId : null,
      clientName: r.inWindow ? r.clientName : null,
      dealId: r.inWindow ? r.dealId : null,
    }),
  );
};

// ---------------------------------------------------------------------------
// Страница встречи
// ---------------------------------------------------------------------------

export interface ConsultationView {
  booking: BookingView;
  clientName: string;
  /** Имя консультанта записи; null — «серая». */
  consultantName: string | null;
  deal: { id: string; stageKey: string; status: 'open' | 'won' | 'lost'; version: number } | null;
  /** Открытые этапы воронки сделки впереди текущего («Переговоры / КП», «Счёт»): итог может перевести сделку на один из них. */
  laterStages: { key: string; label: LocalizedLabel | null }[];
  /** Итог можно писать только после «Пришёл» (иначе `not_attended`). */
  canRecordResult: boolean;
}

/** Встреча для её страницы. Консультант по отношению видит только свои записи; чужая и несуществующая — 404. */
export async function getMyConsultation(deps: BookingDeps, viewer: Viewer, bookingId: string): Promise<ConsultationView> {
  const spaceId = requireSpace(viewer);
  return inBookingTx({}, async (tx) => {
    const b = await findBooking(viewer, tx, { id: bookingId, perm: 'booking.read', lock: false });
    if (!b || b.kind !== 'individual' || b.spaceId !== spaceId) throw notFound();
    if (scopeOf(viewer, 'booking.read') === null && !(await isMyResourceBooking(tx, { bookingId: b.id, userId: viewer.userId }))) throw notFound();
    const [clientName, owner, dealRow] = await Promise.all([
      clientNameOf(tx, b.clientId),
      b.resourceId ? resourceUserOf(tx, b.resourceId) : Promise.resolve(null),
      b.dealId ? findDealBrief(viewer, tx, b.dealId) : Promise.resolve(null),
    ]);
    const laterStages = dealRow && dealRow.status === 'open' ? await deps.deals.laterOpenStages(spaceId, dealRow.pipelineKey, dealRow.stageKey) : [];
    return {
      booking: toBookingView(b),
      clientName,
      consultantName: owner?.name ?? null,
      deal: dealRow ? { id: dealRow.id, stageKey: dealRow.stageKey, status: dealRow.status, version: dealRow.version } : null,
      laterStages,
      canRecordResult: b.status === 'attended',
    };
  });
}

// ---------------------------------------------------------------------------
// Итог встречи
// ---------------------------------------------------------------------------

/**
 * Итог: заметка, следующий шаг (ручная задача себе), этап сделки. Порядок: запись → карточка `FOR UPDATE` → запись
 * `FOR UPDATE`, статус `attended` → повтор по `client_events.id = opId` → заметка (`notes.id = opId`) → задача →
 * этап → событие `booking.result`. Пустая заметка без шага и этапа — 400. Без заметки `noteId` в ответе пуст.
 */
export const recordConsultResult: RecordConsultResult = async (deps, viewer, input) => {
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const note = input.note.trim();
  if (note.length > NOTE_MAX) throw new BadRequestError('note');
  if (note === '' && input.nextStep === null && input.toStageKey === null) throw new BadRequestError('empty_result');
  if (input.nextStep) {
    if (!Number.isFinite(input.nextStep.dueAt) || input.nextStep.dueAt <= now) throw new BadRequestError('next_step');
    if (input.nextStep.kind !== 'call' && input.nextStep.kind !== 'meeting') throw new BadRequestError('next_step');
  }
  if (input.toStageKey !== null && input.dealVersion === null) throw new BadRequestError('deal_version');

  return inBookingTx({}, async (tx) => {
    const probe = await findBooking(viewer, tx, { id: input.bookingId, perm: 'note.write', lock: false });
    if (!probe || probe.spaceId !== spaceId) throw notFound();
    if (probe.kind !== 'individual') throw new BookingDomainError('not_an_individual_event');
    // Консультант по отношению пишет итог только по своим встречам (клиент мог попасть в окно и по чужой записи)
    if (scopeOf(viewer, 'note.write') === null && !(await isMyResourceBooking(tx, { bookingId: probe.id, userId: viewer.userId }))) throw notFound();
    const card = await lockCardOfBooking(tx, probe.cardId);
    if (!card) throw new Error('booking: у записи нет карточки');
    const b = await findBooking(viewer, tx, { id: input.bookingId, perm: 'note.write', lock: true });
    if (!b) throw notFound();
    if (b.status !== 'attended') throw new BookingDomainError('not_attended');

    // повтор: событие итога уже есть — отдаём прежний ответ без эффектов
    const seen = await findFeedById(tx, input.opId);
    if (seen) {
      if (seen.kind !== 'booking.result' || seen.refId !== b.id) throw new BookingDomainError('request_reused');
      const d = seen.data;
      return { bookingId: b.id, noteId: typeof d.noteId === 'string' ? d.noteId : '', taskId: typeof d.taskId === 'string' ? d.taskId : null, replayed: true };
    }

    let noteId = '';
    if (note !== '') {
      noteId = input.opId;
      await insertNote(tx, { id: noteId, clientId: b.clientId, spaceId, dealId: b.dealId, authorId: viewer.userId, body: note, at: now });
      await insertNoteFeed(tx, { clientId: b.clientId, spaceId, dealId: b.dealId, actorId: viewer.userId, noteId, at: now });
    }

    let taskId: string | null = null;
    if (input.nextStep) {
      taskId = newId();
      await insertManualTask(tx, { id: taskId, spaceId, clientId: b.clientId, dealId: b.dealId, kind: input.nextStep.kind, dueAt: input.nextStep.dueAt, assigneeUserId: viewer.userId, at: now });
    }

    if (input.toStageKey !== null) {
      if (!b.dealId) throw new BadRequestError('no_deal');
      await deps.deals.moveToStage(tx, viewer, { dealId: b.dealId, version: input.dealVersion as number, toStageKey: input.toStageKey, bookingId: b.id, at: now });
    }

    const written = await insertFeedWithId(tx, {
      id: input.opId,
      clientId: b.clientId,
      spaceId,
      dealId: b.dealId,
      kind: 'booking.result',
      actorId: viewer.userId,
      bookingId: b.id,
      at: now,
      data: { bookingId: b.id, noteId, taskId, toStageKey: input.toStageKey },
    });
    // Параллельный дубль с тем же opId невозможен под блокировкой карточки; страховка от чужого id события
    if (!written) await throwNotFoundOrConflict(viewer, tx, 'booking', b.id);
    return { bookingId: b.id, noteId, taskId, replayed: false };
  });
};
