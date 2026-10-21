// Правило часов лицензии (ARCHITECTURE §8.4, D-029, D-211, D-212, D-306, D-314). Целые epoch-мс на входе и выходе.
// lastSeenAt — максимум виденного «сейчас» (license_state.last_seen_at); время лицензии назад не идёт.
// Вперёд: lastSeenAt за один шаг уходит не больше чем на 48 ч; больший скачок часов — тревога, и шаг в этом режиме
// делается не чаще раза в час (lastStepAt). Так ложная дата в будущем не успевает «состарить» лицензию.
// Назад (D-314, проще D-306): часы позади lastSeenAt больше чем на 10 минут — эпизод «часы позади». Время лицензии
// стоит на lastSeenAt (срок не идёт назад и не продлевается дальше эпизода), а длительность эпизода считается по
// ходу самих часов от прошлого пересчёта (показание в БД, перезапуск его не теряет) и по монотонному времени
// процесса (опора в памяти процесса, приходит параметром). Эпизод дольше 48 ч — «только чтение» с причиной clock.
// Эпизод кончается сам, когда часы снова не позади lastSeenAt больше допуска: блокировка снимается без psql, и ничего
// из эпизода (ни длительность, ни шаги перезапусков) в следующий спокойный ход не переносится. Шагов за перезапуск
// нет, дробей нет: mono округляется вниз до целых мс до любой арифметики.
// Не закрыто (D-314, остаток): часы, которые root держит стоящими или замедленными (цикл date -s), часы назад с
// возвратом к lastSeenAt хотя бы на одну проверку раз в 48 ч (эпизод кончается и не переносится) и часы назад вместе
// с правкой license_state — без доверенного времени (онлайн-проверки) не отличить от верных.
// Date.now() здесь не вызывается: часы и монотонное время — параметры.
export const CLOCK_MAX_STEP_MS = 48 * 3_600_000;
export const CLOCK_JUMP_STEP_INTERVAL_MS = 3_600_000;
/** Отставание часов не больше этого — дрейф, а не перевод назад (тревоги и эпизода нет, время ждёт часы). */
export const CLOCK_BACKWARD_TOLERANCE_MS = 10 * 60_000;
/** Эпизод «часы позади» дольше этого — «только чтение», причина clock. */
export const CLOCK_BEHIND_LOCK_MS = 48 * 3_600_000;
/** Пока эпизод длится, тревога повторяется с этим шагом. */
export const CLOCK_BEHIND_ALERT_EVERY_MS = 24 * 3_600_000;

/** Опора процесса: монотонное время (целые мс) прошлого пересчёта, эпизод и его длительность тогда. В памяти процесса. */
export type ClockAnchor = { mono: number; since: number | null; forMs: number };
/** Эпизод «часы позади» (в БД): lastSeenAt в начале, показание часов на прошлом пересчёте, длительность. */
export type ClockBehind = { since: number; lastClock: number; forMs: number };

export type ClockInput = {
  /** Показание часов сервера. */
  clock: number;
  /** Максимум виденного времени (license_state.last_seen_at); null — первая проверка. */
  lastSeenAt: number | null;
  /** Момент последнего шага lastSeenAt по часам (license_state.checked_at). */
  lastStepAt: number | null;
  /** Эпизод «часы позади»; null — эпизода нет. */
  behind: ClockBehind | null;
  /** Монотонное время процесса сейчас (performance.now(), может быть дробным). */
  mono: number;
  /** Опора этого процесса с его прошлого пересчёта; null — первый пересчёт после старта. */
  anchor: ClockAnchor | null;
};

export type ClockJump = 'none' | 'backward' | 'forward';

export type ClockResult = {
  /** Эффективное «сейчас» для оценки срока. */
  now: number;
  lastSeenAt: number;
  lastStepAt: number;
  behind: ClockBehind | null;
  jump: ClockJump;
  /** В режиме скачка вперёд lastSeenAt сдвинут на 48 ч (не чаще раза в час). */
  stepped: boolean;
  /** Сколько длится эпизод «часы позади»; 0 — эпизода нет. */
  behindForMs: number;
  /** Эпизод дольше 48 ч: «только чтение», причина clock (evaluateLicense clockLocked). */
  locked: boolean;
  /** Записать тревогу license.clock_jump backward: начало эпизода или очередные сутки. */
  alert: boolean;
  /** Новая опора процесса. */
  anchor: ClockAnchor;
};

/** Целые мс для BIGINT: дробь (performance.now()) отбрасывается, не-число — ошибка разработчика. */
export function wholeMs(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError('clock: время не число');
  return Math.floor(n);
}

export function advanceClock(input: ClockInput): ClockResult {
  const clock = wholeMs(input.clock);
  const mono = wholeMs(input.mono);
  const { lastSeenAt, behind, anchor } = input;
  if (lastSeenAt === null) return calm(clock, clock, clock, 'none', false, mono);
  const step = input.lastStepAt ?? lastSeenAt;

  if (lastSeenAt - clock > CLOCK_BACKWARD_TOLERANCE_MS) {
    // Эпизод: время лицензии стоит. Длительность — максимум из хода часов от прошлого пересчёта (любого процесса;
    // назад — 0, вперёд — не больше 48 ч) и монотонного времени этого процесса от его опоры в том же эпизоде.
    // Максимум, а не сумма: процессы не складывают свои интервалы
    const since = behind?.since ?? lastSeenAt;
    const before = behind?.forMs ?? 0;
    const byClock = behind !== null && clock > behind.lastClock ? Math.min(clock - behind.lastClock, CLOCK_MAX_STEP_MS) : 0;
    const sameEpisode = behind !== null && anchor !== null && anchor.since === behind.since && mono >= anchor.mono;
    const byMono = sameEpisode ? anchor.forMs + (mono - anchor.mono) : 0;
    const forMs = Math.max(before + byClock, byMono, before);
    const every = CLOCK_BEHIND_ALERT_EVERY_MS;
    return {
      now: lastSeenAt,
      lastSeenAt,
      lastStepAt: step,
      behind: { since, lastClock: clock, forMs },
      jump: 'backward',
      stepped: false,
      behindForMs: forMs,
      locked: forMs > CLOCK_BEHIND_LOCK_MS,
      alert: behind === null || Math.floor(forMs / every) > Math.floor(before / every),
      anchor: { mono, since, forMs },
    };
  }
  // Дрейф назад в пределах допуска: время ждёт часы
  if (clock < lastSeenAt) return calm(lastSeenAt, lastSeenAt, step, 'none', false, mono);
  // Конец эпизода: за него прошло behind.forMs, поэтому шаг к часам без тревоги — на 48 ч плюс эпизод
  if (clock - lastSeenAt <= CLOCK_MAX_STEP_MS + (behind?.forMs ?? 0)) return calm(clock, clock, clock, 'none', false, mono);
  // Скачок вперёд больше 48 ч: сервер стоял (законно) или часы ушли вперёд. Считаем по часам, но максимум
  // виденного двигаем на 48 ч и не чаще раза в час — после починки часов лицензия снова идёт по ним
  const canStep = clock < step || clock - step >= CLOCK_JUMP_STEP_INTERVAL_MS;
  const seen = canStep ? lastSeenAt + CLOCK_MAX_STEP_MS : lastSeenAt;
  return calm(clock, seen, canStep ? clock : step, 'forward', canStep, mono);
}

function calm(now: number, lastSeenAt: number, lastStepAt: number, jump: ClockJump, stepped: boolean, mono: number): ClockResult {
  return { now, lastSeenAt, lastStepAt, behind: null, jump, stepped, behindForMs: 0, locked: false, alert: false, anchor: { mono, since: null, forMs: 0 } };
}
