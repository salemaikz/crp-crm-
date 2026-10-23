// Одно правило просрочки перезвона (pipeline-v2 §4.3). Границы считаются один раз для «сейчас»
// и передаются в SQL параметрами; все места (тревога, сводка, задачи, очередь) используют их же.

import type { CallbackPrecision, Ms, WorkCalendar } from './spec/types.js';

const DAY_MS = 86_400_000;

export interface DueBounds {
  /** `now − допуск`: срок «время» просрочен, если `nextCallAt <= timeBefore`. */
  timeBefore: Ms;
  /** Начало сегодняшних местных суток: срок «день» просрочен, если `nextCallAt < dayBefore`. */
  dayBefore: Ms;
  /** Начало завтрашних местных суток. */
  tomorrowStart: Ms;
}

/** Первый момент из `[lo, hi]`, где `pred` истинно (pred монотонен: ложь…ложь, истина…истина). */
function firstTrue(lo: Ms, hi: Ms, pred: (t: Ms) => boolean): Ms {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (pred(mid)) b = mid;
    else a = mid + 1;
  }
  return a;
}

/** Границы для одного «сейчас». Начало суток ищется по `localDay`, поэтому календарь не обязан его знать. */
export function dueBounds(now: Ms, toleranceMin: number, cal: WorkCalendar): DueBounds {
  const today = cal.localDay(now);
  // Сутки длиннее 24 ч не бывают, поэтому полночь лежит в пределах 25 часов от `now`.
  const dayBefore = firstTrue(now - DAY_MS - 3_600_000, now, (t) => cal.localDay(t) === today);
  const tomorrowStart = firstTrue(now, now + DAY_MS + 3_600_000, (t) => cal.localDay(t) !== today);
  return { timeBefore: now - toleranceMin * 60_000, dayBefore, tomorrowStart };
}

/** Просрочен ли срок. «День»: просрочен с начала следующих календарных суток, выходные не исключаются. */
export function isOverdue(nextCallAt: Ms, precision: CallbackPrecision, b: DueBounds): boolean {
  return precision === 'day' ? nextCallAt < b.dayBefore : nextCallAt <= b.timeBefore;
}

/** Огонёк карточки: просрочен, на сегодня или нет (срок позже сегодняшних суток либо не задан). */
export function fireOf(nextCallAt: Ms | null, precision: CallbackPrecision, b: DueBounds): 'overdue' | 'today' | null {
  if (nextCallAt === null) return null;
  if (isOverdue(nextCallAt, precision, b)) return 'overdue';
  return nextCallAt < b.tomorrowStart ? 'today' : null;
}
