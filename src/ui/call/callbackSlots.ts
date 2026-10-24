// Слоты времени перезвона (D-358 п. 5): список HH:mm шагом 15 минут в окне звонков установки.
// Нативный <input type="time"> показывает «09:00 AM» по локали системы, поэтому время выбирается из списка.
import { slotMinutes } from './slotMath';

export const SLOT_STEP_MIN = 15;

const pad = (n: number) => String(n).padStart(2, '0');
const toHhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Слоты от начала окна до его конца включительно; `keep` — текущее значение вне сетки, оно остаётся в списке. */
export function timeSlots(start: string, end: string, step = SLOT_STEP_MIN, keep?: string): string[] {
  const a = slotMinutes(start);
  const b = slotMinutes(end);
  if (a === null || b === null || b < a) return [];
  const out: string[] = [];
  for (let m = a; m <= b; m += step) out.push(toHhmm(m));
  if (keep !== undefined && slotMinutes(keep) !== null && !out.includes(keep)) out.push(keep);
  return out.sort();
}

/** Подпись слота: всегда 24 часа («09:00»), без AM/PM (Intl с hourCycle h23 даёт то же для HH:mm). */
export function slotLabel(hhmm: string): string {
  const m = slotMinutes(hhmm);
  return m === null ? hhmm : toHhmm(m);
}
