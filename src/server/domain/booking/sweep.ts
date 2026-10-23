// Сверки записи (B4b, docs/deals-handoffs-design.md §3; PROCESS 3.5 № 28–29; D-243, D-244):
// 1. неотмеченная явка — напоминание отметчику и РОП, затем «Не пришёл» по сроку;
// 2. «Договорились» без следующего шага — задача владельцу.
// Каждая запись и каждая карточка — своя транзакция, исполнитель — система воркера. Порядок блокировок:
// карточка → запись (D-131). Повторный прогон ничего не задваивает: задачи держатся ключами, «Не пришёл» уже стоит.
import { booking } from '@crm/core';
import { resolveLead } from '@/server/domain/cards';
import { closeAutoTaskByKey, ensureAutoTask } from '@/server/domain/tasks/auto';
import type { SystemActor } from '@/server/access';
import { getDb, newId } from '@/server/platform/db';
import { noteCardEvent } from './cardEvents';
import { loadBookingOpsSettings } from './opsSettings';
import {
  attendanceMarkKeys,
  findBooking,
  hasOtherFutureBooking,
  insertFeed,
  insertHistory,
  lockCardOfBooking,
  updateStatus,
} from './repo';
import {
  SWEEP_LIMIT,
  SWEEP_WINDOW_DAYS,
  activeResourceUser,
  countAgreedWithoutStepRows,
  countUnmarkedBookings,
  firstDutyUser,
  listAgreedWithoutStepIds,
  listUnmarkedBookingIds,
  stepFacts,
} from './repo.sweep';
import type { CountAgreedWithoutStep, CountUnmarkedAttendance, RunAttendanceSweep, SweepReport, WorkdaysAfter } from './dutyTypes';
import { inBookingTx } from './tx';
import type { BookingDeps, SweepAttendance } from './types';

/** Предохранитель цикла: окно просмотра 60 дней с запасом. */
const MAX_SPAN_DAYS = 400;

/** Рабочие дни строго после `day` и не позже `today` (чистая функция, календарь из настроек). */
export const workdaysAfter: WorkdaysAfter = (calendar, day, today) => {
  let n = 0;
  let d = day;
  for (let i = 0; i < MAX_SPAN_DAYS && d < today; i++) {
    d = booking.addDays(d, 1);
    if (calendar.isWorkday(d)) n += 1;
  }
  return n;
};

/**
 * Одна запись (§3.2 шаги 1–6). `skipped` — отмечена, ещё не прошёл ни один рабочий день, нет отметчика
 * или карточка не приняла событие; в этом случае ничего не записано.
 */
async function sweepOne(deps: BookingDeps, actor: SystemActor, a: { bookingId: string; opId: string; now: number }): Promise<'marked' | 'reminded' | 'skipped'> {
  const { now } = a;
  return inBookingTx({}, async (tx) => {
    // 1. запись без блокировки → карточка FOR UPDATE → запись FOR UPDATE (порядок D-131)
    const probe = await findBooking(actor, tx, { id: a.bookingId, perm: 'booking.attend', lock: false });
    if (!probe) return 'skipped';
    const card = await lockCardOfBooking(tx, probe.cardId);
    if (!card) return 'skipped';
    const b = await findBooking(actor, tx, { id: a.bookingId, perm: 'booking.attend', lock: true });
    if (!b || (b.status !== 'registered' && b.status !== 'confirmed')) return 'skipped';

    // 2. сколько рабочих дней прошло
    const [settings, ops] = await Promise.all([deps.settings(b.spaceId, now), loadBookingOpsSettings(b.spaceId, now)]);
    const today = booking.epochToLocalDate(settings.timeZone, now);
    const elapsed = workdaysAfter(settings.calendar, b.bookingDate, today);
    if (elapsed <= 0) return 'skipped';

    // 3. отметчик: дежурный, консультант, иначе руководитель (нет дежурных, «серая» заявка, консультант выключен)
    let marker: string | null = null;
    if (b.eventId) marker = await firstDutyUser(tx, { eventId: b.eventId, spaceId: b.spaceId });
    else if (b.resourceId) marker = await activeResourceUser(tx, { resourceId: b.resourceId, spaceId: b.spaceId });
    const lead = await resolveLead(tx, { spaceId: b.spaceId, ownerUserId: card.ownerUserId, at: now });
    marker ??= lead;
    if (!marker) {
      console.warn('[booking] attendance-sweep: отметчик не найден, запись пропущена');
      return 'skipped';
    }

    // 4–5. сроки и карточка
    const reached = ops.autoNoShowWorkdays !== null && elapsed >= ops.autoNoShowWorkdays;
    if (card.state === 'agreed') {
      const other = await hasOtherFutureBooking(tx, { spaceId: b.spaceId, clientId: b.clientId, excludeId: b.id, now });
      const code = await noteCardEvent(
        deps,
        tx,
        actor,
        card,
        { type: 'attendance_sweep', opId: a.opId, bookingId: b.id, markerUserId: marker, facts: { workdaysElapsed: elapsed, hasOtherFutureBooking: other } },
        now,
      );
      if (code) {
        console.warn(`[booking] attendance-sweep: карточка не приняла событие (${code})`);
        return 'skipped';
      }
    } else if (reached) {
      for (const sourceKey of attendanceMarkKeys(b.id)) await closeAutoTaskByKey(tx, actor, { sourceKey, at: now });
    } else {
      const [markerKey, leadKey] = attendanceMarkKeys(b.id) as [string, string];
      const base = { spaceId: b.spaceId, clientId: b.clientId, dealId: b.dealId, source: 'attendance_mark' as const, kind: 'check' as const, dueAt: now, at: now };
      await ensureAutoTask(tx, actor, { ...base, assigneeUserId: marker, sourceKey: markerKey });
      if (lead) await ensureAutoTask(tx, actor, { ...base, assigneeUserId: lead, sourceKey: leadKey });
    }
    if (!reached) return 'reminded';

    // 6. «Не пришёл» по сроку: статус, история без автора, лента
    const updated = await updateStatus(actor, tx, { id: b.id, version: b.version, to: 'no_show', cancelReason: '', perm: 'booking.attend', at: now });
    if (!updated) throw new Error('booking: версия записи изменилась под блокировкой');
    await insertHistory(tx, { bookingId: b.id, action: 'auto_no_show', from: b.status, to: 'no_show', actorId: null, meta: { job: 'attendance-sweep', elapsed }, at: now });
    await insertFeed(tx, {
      clientId: b.clientId,
      spaceId: b.spaceId,
      dealId: b.dealId,
      kind: 'booking.status',
      actorId: null,
      bookingId: b.id,
      at: now,
      data: { bookingId: b.id, from: b.status, to: 'no_show', reason: 'auto' },
    });
    // Событие карточки шло до смены статуса и читало запись ещё не «неявкой»: кэш признаков пересчитываем после (§5.1)
    await deps.cards.refreshDerived?.(tx, actor, { spaceId: b.spaceId, clientId: b.clientId });
    return 'marked';
  });
}

export const sweepAttendance: SweepAttendance = (deps, actor, input) => sweepOne(deps, actor, { ...input, now: deps.now() });

/** Карточка «Договорились» без шага (§3.3): факты заново под блокировкой, событие `agreed_sweep`. */
async function sweepAgreedOne(deps: BookingDeps, actor: SystemActor, a: { cardId: string; now: number }): Promise<boolean> {
  return inBookingTx({}, async (tx) => {
    const card = await lockCardOfBooking(tx, a.cardId);
    if (!card || card.state !== 'agreed') return false;
    const facts = await stepFacts(tx, { spaceId: card.spaceId, clientId: card.clientId, now: a.now });
    if (facts.hasFutureBooking || facts.hasOpenOwnerTask) return false;
    const code = await noteCardEvent(deps, tx, actor, card, { type: 'agreed_sweep', opId: newId(), facts }, a.now);
    if (code) {
      console.warn(`[booking] attendance-sweep: карточка не приняла agreed_sweep (${code})`);
      return false;
    }
    return true;
  });
}

/** Один прогон по пространству: явка, затем «Договорились» без шага. Сбой одной записи не останавливает остальные. */
export const runAttendanceSweep: RunAttendanceSweep = async (deps, actor, input) => {
  const { spaceId, now } = input;
  const settings = await deps.settings(spaceId, now);
  const today = booking.epochToLocalDate(settings.timeZone, now);
  const fromDay = booking.addDays(today, -SWEEP_WINDOW_DAYS);
  const report: SweepReport = { reminded: 0, marked: 0, skipped: 0, agreedChecked: 0, nextStepTasks: 0 };
  const db = await getDb();

  const ids = await listUnmarkedBookingIds(actor, db.sql, {
    spaceId,
    fromEpoch: booking.localToEpoch(settings.timeZone, fromDay, '00:00'),
    todayEpoch: booking.localToEpoch(settings.timeZone, today, '00:00'),
    fromDay,
    today,
    limit: SWEEP_LIMIT,
  });
  for (const bookingId of ids) {
    try {
      const r = await sweepOne(deps, actor, { bookingId, opId: newId(), now });
      if (r === 'marked') report.marked += 1;
      else if (r === 'reminded') report.reminded += 1;
      else report.skipped += 1;
    } catch (e) {
      console.error('[booking] attendance-sweep: сбой записи', (e as Error).message);
      report.skipped += 1;
    }
  }

  // «Договорились» без шага — после явки: «Не пришёл» мог вернуть карточку из agreed
  const cardIds = await listAgreedWithoutStepIds(actor, db.sql, { spaceId, now, limit: SWEEP_LIMIT });
  for (const cardId of cardIds) {
    try {
      report.agreedChecked += 1;
      if (await sweepAgreedOne(deps, actor, { cardId, now })) report.nextStepTasks += 1;
    } catch (e) {
      console.error('[booking] attendance-sweep: сбой карточки', (e as Error).message);
    }
  }
  return report;
};

/** Для тревоги РОП «Явка не отмечена»: записи прошедших дней без отметки в окне просмотра. */
export const countUnmarkedAttendance: CountUnmarkedAttendance = async (actor, input) => {
  const db = await getDb();
  return countUnmarkedBookings(actor, db.sql, { spaceId: input.spaceId, fromDay: booking.addDays(input.today, -SWEEP_WINDOW_DAYS), today: input.today });
};

/** Часть ночной сверки `invariants`. */
export const countAgreedWithoutStep: CountAgreedWithoutStep = async (actor) => {
  const db = await getDb();
  return countAgreedWithoutStepRows(actor, db.sql, { now: actor.now });
};
