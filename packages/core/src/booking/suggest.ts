/**
 * Подбор консультанта: кого предложить на это время по направлению запроса клиента.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/suggest.ts (`rankConsultants`, `rankAssignCandidates`).
 * Направления — ключи `booking.directions[]` (строки из настроек), а не закрытый список в коде.
 *
 * КТО КАНДИДАТ. Только то, что сервер потом и правда примет:
 *   • rankConsultants (новая запись к консультанту) — консультант с графиком, у которого в это
 *     время начинается слот и в слоте есть место (занятый слот с запасом — резерв); консультант
 *     БЕЗ графика — если интервал внутри общих часов `booking.consult.hours` и свободен (резерва нет);
 *   • rankAssignCandidates («серая» запись) — кто свободен в её время для основной записи.
 * ПРАВИЛО (PROCESS §5.2): у кого нет своего графика, работает общий график `booking.consult.hours`,
 * и такой консультант — кандидат наравне с остальными; оба ранжировщика, `poolRoom` и
 * `assignCandidates` считают это одинаково через `isFreeAt`.
 * В обоих случаях отбрасывается тот, кого запись отняла бы у других «серых» на это время
 * (`starvedGreyBooking`): сервер такую запись отверг бы (`pool_full`).
 *
 * ПОРЯДОК (PROCESS §5.2): совпало направление → меньше записей в этот день → порядок
 * консультантов (`sort`) → имя. Подбор не знает, на месте ли консультант фактически,
 * поэтому режим `booking.grey.mode = suggest` оставляет решение за РОП.
 */

import type { Consultant, SlotBooking } from './types';
import { assignCandidates, isFreeAt, planFor, starvedGreyBooking, type DaySnapshot } from './daySnapshot';
import { countOverlapping, slotStarts } from './slots';
import { timeToMin } from './time';

export interface RankedConsultant {
  consultantId: string;
  name: string;
  /** У консультанта есть направление запроса клиента. */
  directionMatch: boolean;
  /** Сколько занимающих место записей индивидуальных видов у него в этот день. */
  dayLoad: number;
  /** Слот уже занят, запись пойдёт резервом. */
  reserve: boolean;
}

/** Записи консультанта в этот день; excludeBookingId — та, что сейчас назначается. */
function dayLoad(snap: DaySnapshot, consultantId: string, excludeBookingId?: string): number {
  return snap.bookings.filter((b) => b.consultantId === consultantId && b.id !== excludeBookingId).length;
}

function matches(c: Consultant, directionKey: string | null | undefined): boolean {
  return !!directionKey && c.directions.includes(directionKey);
}

interface Candidate {
  ranked: RankedConsultant;
  sort: number;
}

function byRank(a: Candidate, b: Candidate): number {
  if (a.ranked.directionMatch !== b.ranked.directionMatch) return a.ranked.directionMatch ? -1 : 1;
  if (a.ranked.dayLoad !== b.ranked.dayLoad) return a.ranked.dayLoad - b.ranked.dayLoad;
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.ranked.name.localeCompare(b.ranked.name, 'ru');
}

function finish(list: Candidate[]): RankedConsultant[] {
  return list.sort(byRank).map((c) => c.ranked);
}

/**
 * Кого предложить для НОВОЙ записи на время `at.startTime`.
 *
 * Консультанту с графиком запись ложится в его слот целиком, поэтому важен старт слота,
 * а длина — его `slotMin`. `opts.bookingId` — запись уже есть в снимке (переназначение
 * «серой»): она не считается чужой занятостью и не «отнимается» сама у себя.
 */
export function rankConsultants(
  snap: DaySnapshot,
  at: { startTime: string; /** Длина записи для консультанта без графика; по умолчанию его `slotMin`. */ durationMin?: number },
  directionKey: string | null | undefined,
  opts: { bookingId?: string } = {},
): RankedConsultant[] {
  const start = timeToMin(at.startTime);
  const out: Candidate[] = [];
  for (const c of snap.consultants) {
    if (!c.active) continue;
    if (!c.usesSchedule) {
      // Без графика — общие часы: интервал внутри часов и ни с чем не пересекается (как в isFreeAt).
      const durationMin = at.durationMin ?? c.slotMin;
      if (!isFreeAt(snap, c, start, durationMin, opts.bookingId)) continue;
      const placement = { id: opts.bookingId ?? null, consultantId: c.id, startTime: at.startTime, durationMin };
      if (starvedGreyBooking(snap, placement)) continue;
      out.push({
        ranked: {
          consultantId: c.id,
          name: c.name,
          directionMatch: matches(c, directionKey),
          dayLoad: dayLoad(snap, c.id, opts.bookingId),
          reserve: false,
        },
        sort: c.sort,
      });
      continue;
    }
    if (!slotStarts(planFor(snap, c), c.slotMin).includes(start)) continue;
    const own: SlotBooking[] = snap.bookings.filter((b) => b.consultantId === c.id && b.id !== opts.bookingId);
    const taken = countOverlapping(start, c.slotMin, own);
    if (taken >= c.capacity) continue;
    const placement = { id: opts.bookingId ?? null, consultantId: c.id, startTime: at.startTime, durationMin: c.slotMin };
    if (starvedGreyBooking(snap, placement)) continue;
    out.push({
      ranked: {
        consultantId: c.id,
        name: c.name,
        directionMatch: matches(c, directionKey),
        dayLoad: dayLoad(snap, c.id, opts.bookingId),
        reserve: taken > 0,
      },
      sort: c.sort,
    });
  }
  return finish(out);
}

/**
 * Кому отдать существующую «серую» запись: свободные в её время для основной записи
 * (резерва при назначении не бывает), в порядке подбора.
 */
export function rankAssignCandidates(
  snap: DaySnapshot,
  booking: Pick<SlotBooking, 'id' | 'startTime' | 'durationMin'>,
  directionKey: string | null | undefined,
): RankedConsultant[] {
  const out: Candidate[] = [];
  for (const c of assignCandidates(snap, booking)) {
    const durationMin = c.usesSchedule ? c.slotMin : booking.durationMin;
    if (starvedGreyBooking(snap, { id: booking.id, consultantId: c.id, startTime: booking.startTime, durationMin })) continue;
    out.push({
      ranked: {
        consultantId: c.id,
        name: c.name,
        directionMatch: matches(c, directionKey),
        dayLoad: dayLoad(snap, c.id, booking.id),
        reserve: false,
      },
      sort: c.sort,
    });
  }
  return finish(out);
}
