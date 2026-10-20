/**
 * Автоназначение «серых» заявок: чистая часть планирования прогона.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/autoAssign.ts — только `greyBookings`,
 * `poolCandidates`, `planGreyProposals`, `pendingGreys`, `nextBoundary`. Прогон с блокировками,
 * SQL и уведомления пишутся заново в домене (job `grey-assign`).
 *
 * «Серая» заявка — запись консультации без консультанта («назначим утром»). Что с ней делать,
 * решает `booking.grey.mode`: assign — назначить лучшего из пула, suggest — прислать РОП
 * предложения. Расписание прогонов — `booking.grey.schedule` (greyTiming.ts).
 *
 * КАНДИДАТЫ — только консультанты пула (autoAssign): «серая» запись при создании рассчитывала
 * на ёмкость пула (`poolRoom`) и только его она и может занять, не отняв время у прямых записей.
 *
 * ПОВТОРНЫЕ ПРОГОНЫ ЗА ДЕНЬ.
 *   • assign: каждый прогон берёт ВСЕ «серые» дня, у которых до сих пор нет консультанта
 *     (PROCESS §5.2: неразмещаемую заявку каждый прогон пробует снова — после того как РОП открыл
 *     окно). Границы нет: она пропустила бы и неразмещённую раньше заявку, и заявку с ранним
 *     createdAt, закоммитившуюся после чтения снимка. Дубля нет: назначенная перестаёт быть «серой».
 *   • suggest: первый прогон за дату берёт все «серые» дня, следующие — только записанные после
 *     прошлого, чтобы не слать РОП одни и те же предложения. Граница — createdAt самой поздней «серой», которую прогоны за дату
 * уже видели (`nextBoundary`); следующий прогон берёт «серые» позже границы (`pendingGreys`),
 * поэтому каждая заявка обрабатывается один раз. Перенос уже обработанной «серой» на другое время
 * того же дня — новая запись, но считается обработанным вместе с исходной (`handledMoves`).
 */

import type { Consultant, GreyMode, SlotBooking } from './types';
import type { DaySnapshot } from './daySnapshot';
import { rankAssignCandidates, type RankedConsultant } from './suggest';

/** «Серые» записи снимка дня — в порядке, в котором их отдал репозиторий (время, создание). */
export function greyBookings(snap: DaySnapshot): SlotBooking[] {
  return snap.bookings.filter((b) => b.consultantId === null);
}

/** Кому из пула можно отдать эту «серую» запись, лучший первым. */
export function poolCandidates(snap: DaySnapshot, booking: SlotBooking): RankedConsultant[] {
  const pool = new Set(snap.consultants.filter((c) => c.active && c.autoAssign).map((c) => c.id));
  return rankAssignCandidates(snap, booking, booking.directionKey).filter((r) => pool.has(r.consultantId));
}

export interface GreyProposal {
  booking: SlotBooking;
  consultantId: string;
  consultantName: string;
  directionMatch: boolean;
}

/** Снимок, будто запись уже отдана консультанту, — как её положило бы назначение. */
function withAssigned(snap: DaySnapshot, bookingId: string, c: Consultant): DaySnapshot {
  return {
    ...snap,
    bookings: snap.bookings.map((b) =>
      b.id === bookingId ? { ...b, consultantId: c.id, isReserve: false, durationMin: c.usesSchedule ? c.slotMin : b.durationMin } : b,
    ),
  };
}

/**
 * Предложения на все «серые» записи дня — по очереди, как их назначал бы режим assign:
 * каждое следующее считается по снимку, где предыдущие уже отданы, поэтому двум записям
 * на одно время не предлагается один консультант. Неразмещаемые возвращаются отдельно
 * (РОП получает задачу «Назначить консультанта», следующий прогон пробует снова).
 */
export function planGreyProposals(
  snap: DaySnapshot,
  greys: readonly SlotBooking[] = greyBookings(snap),
): { proposals: GreyProposal[]; unassignable: SlotBooking[] } {
  const proposals: GreyProposal[] = [];
  const unassignable: SlotBooking[] = [];
  let cur = snap;
  for (const g of greys) {
    const best = poolCandidates(cur, g)[0];
    const c = best && cur.consultants.find((x) => x.id === best.consultantId);
    if (!best || !c) {
      unassignable.push(g);
      continue;
    }
    proposals.push({ booking: g, consultantId: c.id, consultantName: c.name, directionMatch: best.directionMatch });
    cur = withAssigned(cur, g.id, c);
  }
  return { proposals, unassignable };
}

/**
 * «Серые», которые прогон ещё должен обработать.
 *   • assign — все «серые» снимка (без консультанта они и есть необработанные), граница не нужна;
 *   • suggest — первый прогон за дату (boundary = null) берёт все, следующие — записанные позже
 *     границы прошлого прогона, кроме переносов обработанных.
 * Режим по умолчанию — suggest (прежнее поведение).
 */
export function pendingGreys(
  greys: readonly SlotBooking[],
  boundary: number | null,
  handledMoves: ReadonlySet<string> = new Set(),
  mode: GreyMode = 'suggest',
): SlotBooking[] {
  if (mode === 'assign' || boundary === null) return [...greys];
  return greys.filter((b) => b.createdAt > boundary && !handledMoves.has(b.id));
}

/** Граница после прогона (нужна только режиму suggest): ни одна «серая» его снимка второй раз не берётся. */
export function nextBoundary(boundary: number | null, greys: readonly SlotBooking[]): number {
  return greys.reduce((max, b) => Math.max(max, b.createdAt), boundary ?? 0);
}
