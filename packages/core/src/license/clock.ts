// Правило часов лицензии (ARCHITECTURE §8.4, D-029, D-211).
// «Сейчас» = max(часы, lastSeenAt): перевод часов назад не продлевает лицензию.
// lastSeenAt за один шаг уходит вперёд не больше чем на 48 ч; больший скачок часов — тревога, и шаг
// в этом режиме делается не чаще раза в час (lastStepAt), даже если состояние пересчитывают каждую минуту.
// Так ложная дата в будущем не успевает «состарить» лицензию, пока администратор чинит часы.
export const CLOCK_MAX_STEP_MS = 48 * 3_600_000;
export const CLOCK_JUMP_STEP_INTERVAL_MS = 3_600_000;
/** Отставание часов меньше этого — дрейф, а не перевод назад (тревоги нет). */
export const CLOCK_BACKWARD_TOLERANCE_MS = 10 * 60_000;

export type ClockInput = {
  /** Показание часов сервера. */
  clock: number;
  /** Максимум виденного времени (license_state.last_seen_at); null — первая проверка. */
  lastSeenAt: number | null;
  /** Момент последнего шага lastSeenAt по часам (license_state.checked_at). */
  lastStepAt: number | null;
};

export type ClockJump = 'none' | 'backward' | 'forward';

export type ClockResult = {
  /** Эффективное «сейчас» для оценки срока. */
  now: number;
  lastSeenAt: number;
  lastStepAt: number;
  jump: ClockJump;
  /** В режиме скачка вперёд lastSeenAt сдвинут на 48 ч (не чаще раза в час). */
  stepped: boolean;
};

export function advanceClock({ clock, lastSeenAt, lastStepAt }: ClockInput): ClockResult {
  if (lastSeenAt === null) return { now: clock, lastSeenAt: clock, lastStepAt: clock, jump: 'none', stepped: false };
  const step = lastStepAt ?? lastSeenAt;
  if (clock < lastSeenAt) {
    const jump: ClockJump = lastSeenAt - clock > CLOCK_BACKWARD_TOLERANCE_MS ? 'backward' : 'none';
    return { now: lastSeenAt, lastSeenAt, lastStepAt: step, jump, stepped: false };
  }
  if (clock - lastSeenAt <= CLOCK_MAX_STEP_MS) return { now: clock, lastSeenAt: clock, lastStepAt: clock, jump: 'none', stepped: false };
  // Скачок вперёд больше 48 ч: сервер стоял (законно) или часы ушли вперёд. Считаем по часам, но
  // максимум виденного двигаем на 48 ч и не чаще раза в час — после починки часов лицензия снова идёт по ним.
  const canStep = clock < step || clock - step >= CLOCK_JUMP_STEP_INTERVAL_MS;
  if (!canStep) return { now: clock, lastSeenAt, lastStepAt: step, jump: 'forward', stepped: false };
  return { now: clock, lastSeenAt: lastSeenAt + CLOCK_MAX_STEP_MS, lastStepAt: clock, jump: 'forward', stepped: true };
}
