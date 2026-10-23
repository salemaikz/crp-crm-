// Плитки панели директора (§11.1): чистая сборка набора и порядка, без React. Подписи видов записи — из настроек.
import type { DirectorData } from './types';

export type TileId = 'outcomes' | 'connects' | 'bookGroup' | 'bookIndividual' | 'attendance' | 'purchases' | 'pool';

export interface TileSpec {
  id: TileId;
  value: number;
  /** Значение прошлой недели; undefined — сравнения у плитки нет. */
  prev?: number;
  /** Подпись вида записи из настроек (только у плиток «Записи»). */
  label?: string;
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

/** Плитки числом: итоги, дозвоны, записи по двум видам, затем явка, покупки и «В пуле». */
export function directorTiles(d: DirectorData): TileSpec[] {
  return [
    { id: 'outcomes', value: d.calls.outcomes, prev: d.calls.prevOutcomes },
    { id: 'connects', value: d.calls.connects, prev: d.calls.prevConnects },
    { id: 'bookGroup', value: d.bookings.groups, label: d.eventLabels.group },
    { id: 'bookIndividual', value: d.bookings.consults, label: d.eventLabels.individual },
    { id: 'attendance', value: d.attendance.attended },
    { id: 'purchases', value: d.purchases.count },
    { id: 'pool', value: d.stock.poolReady },
  ];
}
