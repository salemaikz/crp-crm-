// Плитки панели директора (§11.1): чистая сборка набора и порядка, без React. Подписи видов записи — из настроек.
import type { DirectorData } from './types';

export type TileId = 'outcomes' | 'connects' | 'bookGroup' | 'bookIndividual' | 'attendance' | 'purchases' | 'conversion' | 'pool';

export interface TileSpec {
  id: TileId;
  value: number;
  /** Значение прошлой недели; undefined — сравнения у плитки нет. */
  prev?: number;
  /** Подпись вида записи из настроек (только у плиток «Записи»). */
  label?: string;
  /** Доля, % (плитка «Средняя конверсия операторов»); null — оператор с нужным числом дозвонов не набрался. */
  rate?: number | null;
}

export interface Delta {
  sign: 'up' | 'down' | 'same';
  abs: number;
}

/** Разница с прошлой неделей: знак и модуль. */
export function delta(current: number, prev: number): Delta {
  const d = current - prev;
  return { sign: d > 0 ? 'up' : d < 0 ? 'down' : 'same', abs: Math.abs(d) };
}

/** Плитки: итоги, дозвоны, записи по двум видам, явка, покупки, средняя конверсия операторов и «В пуле». */
export function directorTiles(d: DirectorData): TileSpec[] {
  return [
    { id: 'outcomes', value: d.calls.outcomes, prev: d.calls.prevOutcomes },
    { id: 'connects', value: d.calls.connects, prev: d.calls.prevConnects },
    { id: 'bookGroup', value: d.bookings.groups, label: d.eventLabels.group },
    { id: 'bookIndividual', value: d.bookings.consults, label: d.eventLabels.individual },
    { id: 'attendance', value: d.attendance.attended },
    { id: 'purchases', value: d.purchases.count },
    { id: 'conversion', value: d.conversion.average ?? 0, rate: d.conversion.average },
    { id: 'pool', value: d.stock.poolReady },
  ];
}

export type FunnelHint = { kind: 'none' } | { kind: 'rate'; value: number } | { kind: 'attendance'; value: number };

export interface FunnelHints {
  connected: FunnelHint;
  lpr: FunnelHint;
  booked: FunnelHint;
  attended: FunnelHint;
  purchased: FunnelHint;
  /** Нужна сноска «воронка периода»: какая-то доля выше 100 % скрыта или покупок больше явок. */
  note: boolean;
  /** Покупки недели без записи (отдельная сноска). */
  withoutBooking: number;
}

/**
 * Подсказки шагов воронки директора. «Пришли» показывает ту же явку, что плитка (пришли / отмеченные), а не долю от
 * всех записей периода: записи будущих дней ещё не могут быть отмечены. Доля выше 100 % без объяснения не выводится
 * (воронка периода считает события разных дат), вместо неё — прочерк и сноска.
 */
export function funnelHints(d: DirectorData): FunnelHints {
  const { counts, rates } = d.funnel;
  let capped = false;
  const rateHint = (r: number | null | undefined): FunnelHint => {
    if (r === null || r === undefined) return { kind: 'none' };
    if (r > 100) {
      capped = true;
      return { kind: 'none' };
    }
    return { kind: 'rate', value: r };
  };
  const attended: FunnelHint = d.attendance.rate === null ? { kind: 'none' } : { kind: 'attendance', value: d.attendance.rate };
  const purchased = rateHint(rates.purchased);
  return {
    connected: rateHint(rates.connected),
    lpr: rateHint(rates.lpr),
    booked: rateHint(rates.booked),
    attended,
    purchased,
    note: capped || counts.purchased > counts.attended,
    withoutBooking: d.purchases.withoutBooking,
  };
}
