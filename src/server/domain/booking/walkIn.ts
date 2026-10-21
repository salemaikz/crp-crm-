// Гость без записи на групповом мероприятии (docs/deals-handoffs-design.md §2.6, D-241, D-040).
// Дежурный вводит номер и имя; номер ищется глобально, но наружу уходит только «найден / новый / проверит РОП» —
// ни имени клиента, ни id, ни владельца. Каждый вызов считается проверкой номера в общем счётчике D-040.
// Порядок блокировок: приём (только новый гость) → карточка → мероприятие → записи (D-251).
import { booking, fields, names, phone } from '@crm/core';
import { BadRequestError, type Viewer } from '@/server/access';
import { resolveLead } from '@/server/domain/cards';
import { ensureAutoTask } from '@/server/domain/tasks/auto';
import { writeAudit } from '@/server/platform/audit';
import { newId, type Sql } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import { markAttendanceIn } from './bookings';
import { noteCardEvent } from './cardEvents';
import { BookingDomainError } from './errors';
import { requireSpace } from './guards';
import type { RegisterWalkIn, WalkInAnswer, WalkInInput, WalkInResult } from './dutyTypes';
import { loadWalkInSettings, resolveStepDue, type WalkInSettings } from './opsSettings';
import {
  countProbesOfDay,
  eventIdOfBooking,
  findClientWithoutCard,
  findEvent,
  findHistoryRow,
  findOpenDealOfClient,
  findProbeOwner,
  findWalkInCandidates,
  hasOtherFutureBooking,
  insertCardCreatedFeed,
  insertFeed,
  insertHistory,
  insertWalkInBooking,
  insertWalkInCard,
  insertWalkInClient,
  insertWalkInProbe,
  isPhoneStopListed,
  lockCardOfBooking,
  lockClientEventBookings,
  lockIntakeForWalkIn,
  setLockTimeout10s,
  type EventRow,
} from './repo';
import { inBookingTx } from './tx';
import type { BookingDeps, BookingSettings, LockedCard } from './types';

const NAME_MAX = 120;
const COMPANY_MAX = 200;
/** Состояния карточки, в которых гость — повод для РОП, а не для следующего шага оператора. */
const CLOSED_STATES: readonly string[] = ['not_interested', 'not_target', 'written_off', 'do_not_call'];

const eventNotFound = () => new BookingDomainError('event_not_found');

interface Ctx {
  deps: BookingDeps;
  viewer: Viewer;
  tx: Sql;
  now: number;
  spaceId: string;
  settings: BookingSettings;
  ops: WalkInSettings;
  input: WalkInInput;
  digits: string;
  phoneKind: string;
  name: string;
  company: string;
  overLimit: boolean;
}

/** Повтор попытки: ключ уже использован. Тот же гость и мероприятие — прежний ответ, иначе `request_reused`. */
async function replayOf(tx: Sql, viewer: Viewer, input: WalkInInput): Promise<WalkInResult | null> {
  const h = await findHistoryRow(tx, input.requestId);
  if (h) {
    if ((await eventIdOfBooking(tx, h.bookingId)) !== input.eventId) throw new BookingDomainError('request_reused');
    const answer = h.meta.answer === 'recorded' || h.meta.answer === 'new' ? h.meta.answer : 'found';
    return { answer: answer as WalkInAnswer, replayed: true };
  }
  // Номер из стоп-листа: записи нет, след только в счётчике проверок
  const owner = await findProbeOwner(tx, input.requestId);
  if (owner === null) return null;
  if (owner !== viewer.userId) throw new BookingDomainError('request_reused');
  return { answer: 'new', replayed: true };
}

export const registerWalkIn: RegisterWalkIn = async (deps, viewer, input) => {
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const name = input.name.trim();
  const company = input.company.trim();
  if (name.length < 1 || name.length > NAME_MAX || company.length > COMPANY_MAX) throw new BadRequestError('walk_in_input');
  const [settings, ops] = await Promise.all([deps.settings(spaceId, now), loadWalkInSettings(spaceId)]);
  const parsed = phone.parsePhone(input.phone, ops.phoneRules);
  if (!parsed || !parsed.working || parsed.digits === null) throw new BadRequestError('phone_invalid');
  const digits = parsed.digits;
  const phoneKind = parsed.kind;

  return inBookingTx({}, async (tx): Promise<WalkInResult> => {
    // Транзакция может взять блокировку приёма: ждать её не дольше 10 с (D-251)
    await setLockTimeout10s(tx);

    // 0. мероприятие: видно по booking.walk_in, сегодня, запланировано, групповое
    const probe = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.walk_in', lock: false });
    if (!probe) throw eventNotFound();
    const today = booking.epochToLocalDate(settings.timeZone, now);
    if (probe.status !== 'scheduled' || probe.eventDate !== today || !settings.groupTypes.some((t) => t.key === probe.eventTypeKey)) {
      throw new BookingDomainError('walk_in_closed');
    }

    // 2. повтор
    const prior = await replayOf(tx, viewer, input);
    if (prior) return prior;

    // 3. счётчик проверок номера (D-040): сверх лимита действие то же, ответ нейтральный
    const probes = await countProbesOfDay(tx, { userId: viewer.userId, day: viewer.today });
    const ctx: Ctx = { deps, viewer, tx, now, spaceId, settings, ops, input, digits, phoneKind, name, company, overLimit: probes >= ops.phoneProbesPerDay };

    // 4. номер: без охвата, наружу — только found/new (D-126)
    let candidates = await findWalkInCandidates(tx, { spaceId, digits });
    if (candidates.length === 0) {
      // Новый гость: приём идёт по одному (D-022); после блокировки ищем ещё раз — гонка уводит в «найден»
      await lockIntakeForWalkIn(tx);
      const again = await replayOf(tx, viewer, input);
      if (again) return again;
      candidates = await findWalkInCandidates(tx, { spaceId, digits });
    }
    const first = candidates[0];
    return first ? foundGuest(ctx, first.cardId, candidates.length > 1) : newGuest(ctx);
  });
};

// ---------------------------------------------------------------------------
// Номер найден
// ---------------------------------------------------------------------------

async function foundGuest(c: Ctx, cardId: string, ambiguous: boolean): Promise<WalkInResult> {
  const { tx, viewer, now, input } = c;
  const card = await lockCardOfBooking(tx, cardId);
  if (!card) throw new Error('walk-in: карточка найденного клиента исчезла');
  const ev = await lockOpenEvent(c);
  const mine = await lockClientEventBookings(tx, { eventId: ev.id, clientId: card.clientId });
  const current = mine[0];

  let bookingId: string;
  let created = false;
  let cardCode: string | null = null;
  if (current) {
    // Уже записан: «Пришёл» тем же путём, что и ручная явка (в том числе исправление «не пришёл»)
    bookingId = current.id;
    if (current.status !== 'attended') {
      await markAttendanceIn(c.deps, viewer, tx, { bookingId: current.id, opId: newId(), version: current.version, to: 'attended' });
    }
  } else {
    const dealId = await findOpenDealOfClient(tx, { spaceId: c.spaceId, clientId: card.clientId, pipelineKey: c.settings.deals?.pipelineKey ?? null });
    bookingId = newId();
    const row = await insertWalkInBooking(tx, {
      id: bookingId,
      spaceId: c.spaceId,
      event: ev,
      clientId: card.clientId,
      cardId: card.id,
      dealId,
      contactId: null,
      // Заслуга владельцу карточки (PROCESS 5.5): гость мог прийти по звонку оператора
      bookedByUserId: card.ownerUserId,
      responsibleUserId: card.ownerUserId,
      requestId: input.requestId,
      at: now,
    });
    if (!row) throw new BookingDomainError('request_reused');
    created = true;
    cardCode = await consequences(c, card, ev, bookingId, dealId);
  }

  if (ambiguous) await reviewTask(c, `walk_in_review:${bookingId}`, card);
  return finish(c, { bookingId, walkIn: 'found', ambiguous, created, event: ev, clientId: card.clientId, dealId: current?.dealId ?? null, cardCode });
}

/** Последствия новой записи гостя по состоянию карточки (§2.6, шаг 4). Возвращает код отказа ядра для истории. */
async function consequences(c: Ctx, card: LockedCard, ev: EventRow, bookingId: string, dealId: string | null): Promise<string | null> {
  const { tx, viewer, now } = c;
  const other = await hasOtherFutureBooking(tx, { spaceId: c.spaceId, clientId: card.clientId, excludeId: bookingId, now });
  if (card.state === 'agreed') {
    return noteCardEvent(c.deps, tx, viewer, card, { type: 'attended', opId: newId(), bookingId, eventDay: ev.eventDate, facts: { hasNextFutureBooking: other } }, now);
  }
  if (CLOSED_STATES.includes(card.state)) {
    await reviewTask(c, `walk_in:${bookingId}`, card);
    return null;
  }
  if (card.state === 'client' && dealId) await c.deps.deals.advanceOnAttended(tx, viewer, { dealId, bookingId, at: now, stages: c.settings.deals });
  // client, new, retry, callback: итог поставит оператор, состояние не меняется; без следующей записи — задача
  if (!other) await nextStepTask(c, card, bookingId, dealId);
  return null;
}

async function nextStepTask(c: Ctx, card: LockedCard, bookingId: string, dealId: string | null): Promise<void> {
  const assignee = card.ownerUserId ?? (await resolveLead(c.tx, { spaceId: c.spaceId, ownerUserId: null, at: c.now }));
  if (!assignee) {
    console.warn('[booking] нет получателя задачи next_step для гостя без записи');
    return;
  }
  await ensureAutoTask(c.tx, c.viewer, {
    spaceId: c.spaceId,
    clientId: card.clientId,
    dealId,
    source: 'next_step',
    kind: 'call',
    assigneeUserId: assignee,
    dueAt: resolveStepDue(c.ops.nextStepTaskAt, c.now, c.settings.calendar),
    sourceKey: `next_step:${bookingId}`,
    at: c.now,
  });
}

/** Задача РОП «проверить» без текста клиента: заголовок пуст, подпись строит интерфейс (D-176). */
async function reviewTask(c: Ctx, sourceKey: string, card: Pick<LockedCard, 'clientId' | 'ownerUserId'>): Promise<void> {
  const lead = await resolveLead(c.tx, { spaceId: c.spaceId, ownerUserId: card.ownerUserId, at: c.now });
  if (!lead) {
    console.warn('[booking] нет получателя задачи review для гостя без записи');
    return;
  }
  await ensureAutoTask(c.tx, c.viewer, { spaceId: c.spaceId, clientId: card.clientId, source: 'review', kind: 'check', assigneeUserId: lead, dueAt: c.now, sourceKey, at: c.now });
}

// ---------------------------------------------------------------------------
// Новый гость
// ---------------------------------------------------------------------------

async function newGuest(c: Ctx): Promise<WalkInResult> {
  const { tx, viewer, now, input, ops } = c;
  const answer: WalkInAnswer = c.overLimit ? 'recorded' : 'new';

  // Стоп-лист: ничего не создаём, ответ тот же, что у «нового», байт в байт — стоп-лист не раскрываем (D-241, D-301)
  if (await isPhoneStopListed(tx, phoneHmac(c.digits))) {
    await writeAudit(tx, { actorId: viewer.userId, action: 'booking.walk_in_skipped', entity: 'event', entityId: input.eventId, spaceId: c.spaceId, meta: { eventId: input.eventId } });
    await insertWalkInProbe(tx, { id: input.requestId, userId: viewer.userId, day: viewer.today, matched: false, at: now });
    return { answer, replayed: false };
  }
  if (ops.walkInSourceKey === null) throw new BookingDomainError('walk_in_source_missing');

  // Клиент мог быть без карточки в этом пространстве: тогда только карточка в пул, клиент не дублируется
  const existingClientId = await findClientWithoutCard(tx, { spaceId: c.spaceId, digits: c.digits });
  const clientId = existingClientId ?? newId();
  const cardId = newId();
  const contactId = newId();
  if (existingClientId) {
    await insertWalkInCard(tx, { cardId, spaceId: c.spaceId, clientId, at: now });
  } else {
    const display = c.company !== '' ? c.company : c.name;
    await insertWalkInClient(tx, {
      clientId,
      cardId,
      contactId,
      kind: c.company !== '' ? 'company' : 'person',
      name: display,
      nameNorm: c.company !== '' ? names.normalizeCompanyName(c.company, ops.legalForms) : names.normalizePersonName(c.name),
      searchNorm: fields.buildSearchNorm({ name: display, orgId: '', phones: [c.digits], custom: {}, searchable: [] }),
      contactName: c.name,
      digits: c.digits,
      phoneKind: c.phoneKind,
      sourceKey: ops.walkInSourceKey,
      spaceId: c.spaceId,
      at: now,
    });
  }
  await insertCardCreatedFeed(tx, { clientId, spaceId: c.spaceId, actorId: viewer.userId, cardId, sourceKey: ops.walkInSourceKey, at: now });

  const ev = await lockOpenEvent(c);
  const bookingId = newId();
  const row = await insertWalkInBooking(tx, {
    id: bookingId,
    spaceId: c.spaceId,
    event: ev,
    clientId,
    cardId,
    dealId: null,
    contactId: existingClientId ? null : contactId,
    bookedByUserId: null,
    responsibleUserId: null,
    requestId: input.requestId,
    at: now,
  });
  if (!row) throw new BookingDomainError('request_reused');
  await reviewTask(c, `walk_in_new:${clientId}`, { clientId, ownerUserId: null });
  return finish(c, { bookingId, walkIn: 'new', ambiguous: false, created: true, event: ev, clientId, dealId: null, cardCode: null });
}

// ---------------------------------------------------------------------------
// Общее
// ---------------------------------------------------------------------------

/** Мероприятие под блокировкой: за время поиска его могли отменить. */
async function lockOpenEvent(c: Ctx): Promise<EventRow> {
  const ev = await findEvent(c.viewer, c.tx, { eventId: c.input.eventId, perm: 'booking.walk_in', lock: true });
  if (!ev) throw eventNotFound();
  if (ev.status !== 'scheduled') throw new BookingDomainError('walk_in_closed');
  return ev;
}

interface Done {
  bookingId: string;
  walkIn: 'found' | 'new';
  ambiguous: boolean;
  created: boolean;
  event: EventRow;
  clientId: string;
  dealId: string | null;
  cardCode: string | null;
}

/** Проверка номера в счётчик, история с ключом попытки (повтор узнаёт её), лента при новой записи. */
async function finish(c: Ctx, d: Done): Promise<WalkInResult> {
  const { tx, viewer, now, input } = c;
  const answer: WalkInAnswer = c.overLimit ? 'recorded' : d.walkIn;
  await insertWalkInProbe(tx, { id: input.requestId, userId: viewer.userId, day: viewer.today, matched: d.walkIn === 'found', at: now });
  await insertHistory(tx, {
    id: input.requestId,
    bookingId: d.bookingId,
    action: 'walk_in',
    from: '',
    to: 'attended',
    actorId: viewer.userId,
    meta: { requestId: input.requestId, walkIn: d.walkIn, answer, ambiguous: d.ambiguous, ...(d.cardCode ? { card: d.cardCode } : {}) },
    at: now,
  });
  if (d.created) {
    await insertFeed(tx, {
      clientId: d.clientId,
      spaceId: c.spaceId,
      dealId: d.dealId,
      kind: 'booking.created',
      actorId: viewer.userId,
      bookingId: d.bookingId,
      at: now,
      data: { bookingId: d.bookingId, eventId: d.event.id, eventTypeKey: d.event.eventTypeKey, eventDate: d.event.eventDate, startTime: d.event.startTime, via: 'walk_in' },
    });
  }
  return { answer, replayed: false };
}
