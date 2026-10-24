/**
 * Обзвон «подтвердить явку» (D-355, docs/pv2-round3.md §1.1, §1.4). Чистое ядро: `now`, пояс, местный день и день
 * недели приходят параметрами, Date.now() не вызывается.
 */
import { addLocalDays, isoWeekday } from '../time';

/** `booking.confirmCall` без `declineReason` (его читает сервер): виды и дни недели обзвона. */
export interface ConfirmCallWindowCfg {
  eventTypes: readonly string[];
  /** Дни обзвона, ISO 1–7. */
  weekdays: readonly number[];
}

export interface ConfirmWindow {
  active: boolean;
  /**
   * Первая местная дата, которая уже не входит в горизонт (начало следующего дня обзвона). null — окно не активно.
   * Мероприятие подтверждается в горизонте, если его местная дата строго меньше этой.
   */
  horizonEndDay: string | null;
}

/** Активно ли окно обзвона в местный `localDay` (день недели `isoWeekday`) и до какого дня тянется горизонт. */
export function confirmWindow(cfg: ConfirmCallWindowCfg, localDay: string, weekday: number): ConfirmWindow {
  if (!cfg.weekdays.includes(weekday)) return { active: false, horizonEndDay: null };
  // Ближайший день обзвона строго после сегодняшнего; единственный день недели — ровно через неделю
  for (let n = 1; n <= 7; n++) {
    const day = addLocalDays(localDay, n);
    if (cfg.weekdays.includes(isoWeekday(day))) return { active: true, horizonEndDay: day };
  }
  return { active: true, horizonEndDay: addLocalDays(localDay, 7) };
}

export type ConfirmMark = 'todo' | 'tried' | 'confirmed';

/** Пометка плитки: registered без недозвонов — todo, с недозвонами — tried, confirmed — confirmed, прочее — без пометки. */
export function confirmMark(status: string, tries: number): ConfirmMark | null {
  if (status === 'confirmed') return 'confirmed';
  if (status === 'registered') return tries >= 1 ? 'tried' : 'todo';
  return null;
}

export interface ConfirmOrderItem {
  mark: ConfirmMark | null;
  /** Время последнего недозвона сегодня; null/0 — недозвонов нет. */
  lastTryAt: number | null;
}

/** Порядок обзвона: todo, затем tried по времени последнего недозвона (раньше — выше), затем всё остальное (0 — равны). */
export function compareConfirm(a: ConfirmOrderItem, b: ConfirmOrderItem): number {
  const rank = (m: ConfirmMark | null): number => (m === 'todo' ? 0 : m === 'tried' ? 1 : 2);
  const d = rank(a.mark) - rank(b.mark);
  if (d !== 0) return d;
  if (a.mark === 'tried' && b.mark === 'tried') return (a.lastTryAt ?? 0) - (b.lastTryAt ?? 0);
  return 0;
}
