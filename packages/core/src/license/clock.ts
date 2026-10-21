// Правило часов лицензии (ARCHITECTURE §8.4, D-029, D-211, D-212, D-306).
// lastSeenAt — максимум виденного «сейчас» (license_state.last_seen_at); время лицензии назад не идёт.
// Вперёд: lastSeenAt за один шаг уходит не больше чем на 48 ч; больший скачок часов — тревога, и шаг в этом режиме
// делается не чаще раза в час (lastStepAt), даже если состояние пересчитывают каждую минуту. Так ложная дата в
// будущем не успевает «состарить» лицензию, пока администратор чинит часы.
// Назад (D-306): часы позади lastSeenAt больше чем на 10 минут — эпизод «часы позади». Время лицензии при этом не
// стоит, а идёт по прошедшему времени, которое видно без часов: монотонное время процесса (performance.now(),
// опора хранится в памяти процесса и приходит параметром) и ход самих часов от прошлого пересчёта (показание
// пишется в БД, поэтому перезапуск процесса его не теряет). Эпизод дольше 48 ч по времени лицензии — «только
// чтение» с причиной clock, пока часы не починят. Тревога — в начале эпизода и раз в сутки.
// realAt — та же оценка, но без вклада шагов вперёд, не подтверждённых монотонным временем (D-312): ни скачка
// больше 48 ч, ни спокойного шага, пока процесс работает. После починки ушедших вперёд часов время лицензии стоит,
// пока часы не догонят lastSeenAt (как до D-306), и блокировки нет — шаги вперёд уже «состарили» лицензию. Пересчёт
// без опоры (первый после старта) прошедшее не видит: realAt — только шаг перезапуска и не дальше часов. Нижней границы
// от показания часов нет (круг 2 раунда 4): часы, спешившие при старте на X > 48 ч, подняли бы её впереди настоящего
// времени на X − 48 ч, и после починки эпизод не кончался бы никогда. Инвариант: realAt не впереди настоящего времени
// (кроме шагов перезапуска). Цена — простой копится запасом без потолка, но не больше самого простоя: это равносильно
// переводу часов назад перед стартом, который root делает и так (D-312).
// Отставание до 10 минут — дрейф: время ждёт часы, но не дольше допуска по монотонному времени.
// Пересчёт без опоры процесса (первый после старта) при часах позади двигает realAt не меньше чем на шаг
// CLOCK_RESTART_STEP_MS — срок кэша состояния процесса: снимок этого пересчёта обслуживает запросы не дольше шага,
// дальше нужен новый пересчёт. Поэтому перезапуск перед каждым пересчётом с часами в одной точке время не
// замораживает: время лицензии растёт не медленнее времени работы процессов, через 48 ч — «только чтение».
// Не закрыто (D-306): часы назад вместе с правкой license_state.
// Date.now() здесь не вызывается: часы и монотонное время — параметры.
export const CLOCK_MAX_STEP_MS = 48 * 3_600_000;
export const CLOCK_JUMP_STEP_INTERVAL_MS = 3_600_000;
/** Отставание часов меньше этого — дрейф, а не перевод назад (тревоги и эпизода нет, время ждёт часы). */
export const CLOCK_BACKWARD_TOLERANCE_MS = 10 * 60_000;
/** Часы позади дольше этого (по времени лицензии) — «только чтение», причина clock. */
export const CLOCK_BEHIND_LOCK_MS = 48 * 3_600_000;
/** Пока эпизод длится, тревога повторяется с этим шагом. */
export const CLOCK_BEHIND_ALERT_EVERY_MS = 24 * 3_600_000;
/** Пересчёт без опоры процесса при часах позади двигает время лицензии не меньше чем на этот шаг. Не меньше срока
 *  кэша состояния процесса (LICENSE_CACHE_TTL_MS): снимок пересчёта живёт не дольше шага. */
export const CLOCK_RESTART_STEP_MS = 60_000;

/** Опора процесса: монотонное время и оценка realAt на его прошлом пересчёте. Живёт в памяти процесса. */
export type ClockAnchor = { mono: number; realAt: number };
/** Эпизод «часы позади»: lastSeenAt в его начале и показание часов на прошлом пересчёте (оба — в БД). */
export type ClockBehind = { since: number; lastClock: number };

export type ClockInput = {
  /** Показание часов сервера. */
  clock: number;
  /** Максимум виденного времени (license_state.last_seen_at); null — первая проверка. */
  lastSeenAt: number | null;
  /** Момент последнего шага lastSeenAt по часам (license_state.checked_at). */
  lastStepAt: number | null;
  /** Оценка времени без шагов вперёд (license_state.clock_real_at); null — равна lastSeenAt. Больше lastSeenAt
   *  не учитывается (обрезается до него). */
  realAt: number | null;
  /** Эпизод «часы позади» (license_state.clock_behind_since/clock_behind_last); null — эпизода нет. */
  behind: ClockBehind | null;
  /** Монотонное время процесса сейчас (performance.now()). */
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
  realAt: number;
  behind: ClockBehind | null;
  jump: ClockJump;
  /** В режиме скачка вперёд lastSeenAt сдвинут на 48 ч (не чаще раза в час). */
  stepped: boolean;
  /** Сколько длится эпизод «часы позади» по времени лицензии; 0 — эпизода нет. */
  behindForMs: number;
  /** Эпизод дольше 48 ч: «только чтение», причина clock (evaluateLicense clockLocked). */
  locked: boolean;
  /** Записать тревогу license.clock_jump backward: начало эпизода или очередные сутки. */
  alert: boolean;
  /** Новая опора процесса. */
  anchor: ClockAnchor;
};

export function advanceClock(input: ClockInput): ClockResult {
  const { clock, lastSeenAt, lastStepAt, behind, mono, anchor } = input;
  if (lastSeenAt === null) return calm(clock, clock, clock, clock, 'none', false, mono);
  const step = lastStepAt ?? lastSeenAt;
  const real0 = Math.min(input.realAt ?? lastSeenAt, lastSeenAt);
  // Прошедшее по монотонному времени этого процесса сверх того, что уже учтено в БД (в том числе другими
  // процессами): опора хранит realAt своего прошлого пересчёта, поэтому интервалы процессов не складываются
  const fresh = anchor === null || mono < anchor.mono;
  const byMono = fresh ? 0 : Math.max(0, anchor.realAt + (mono - anchor.mono) - real0);
  // Без опоры прошедшее процессу не видно: не меньше шага, иначе перезапуск перед каждым пересчётом стопорит время
  const byStart = fresh ? CLOCK_RESTART_STEP_MS : 0;

  if (lastSeenAt - clock > CLOCK_BACKWARD_TOLERANCE_MS) {
    // Ход часов от прошлого пересчёта в эпизоде: виден и после перезапуска; скачок вперёд — не больше 48 ч
    const byClock = behind !== null && clock >= behind.lastClock ? Math.min(clock - behind.lastClock, CLOCK_MAX_STEP_MS) : 0;
    const realAt = real0 + Math.max(byMono, byClock, byStart);
    const now = Math.max(lastSeenAt, realAt);
    const since = behind?.since ?? lastSeenAt;
    const behindForMs = now - since;
    const alert = behind === null || Math.floor(behindForMs / CLOCK_BEHIND_ALERT_EVERY_MS) > Math.floor((lastSeenAt - since) / CLOCK_BEHIND_ALERT_EVERY_MS);
    return {
      now,
      lastSeenAt: now,
      lastStepAt: step,
      realAt,
      behind: { since, lastClock: clock },
      jump: 'backward',
      stepped: false,
      behindForMs,
      locked: behindForMs > CLOCK_BEHIND_LOCK_MS,
      alert,
      anchor: { mono, realAt },
    };
  }
  // Дрейф назад в пределах допуска: время стоит, пока часы не догонят (как было). Но если часы стоят дольше
  // допуска (их возвращают в одну точку), время идёт по монотонному с отставанием на допуск. realAt здесь
  // бывает впереди lastSeenAt не больше чем на допуск: накопленное перезапусками не обрезается до lastSeenAt
  if (clock < lastSeenAt) {
    const drift0 = Math.min(input.realAt ?? lastSeenAt, lastSeenAt + CLOCK_BACKWARD_TOLERANCE_MS);
    const realAt = drift0 + Math.max(fresh ? 0 : Math.max(0, anchor.realAt + (mono - anchor.mono) - drift0), byStart);
    const now = Math.max(lastSeenAt, realAt - CLOCK_BACKWARD_TOLERANCE_MS);
    return calm(now, now, step, realAt, 'none', false, mono);
  }
  if (clock - lastSeenAt <= CLOCK_MAX_STEP_MS) {
    // Шаг часов вперёд в realAt входит только в той мере, в какой его подтверждает монотонное время процесса:
    // иначе часы, спешившие при пересчёте, после починки навсегда позади realAt (эпизод и ложный read_only).
    // Без опоры прошедшее не проверить (простой или спешащие часы): только шаг перезапуска. Граница от показания
    // часов здесь запрещена: спешащие часы подняли бы realAt впереди настоящего времени (D-312, круг 2)
    const realAt = real0 + (fresh ? byStart : byMono);
    return calm(clock, clock, clock, Math.min(clock, realAt), 'none', false, mono);
  }
  // Скачок вперёд больше 48 ч: сервер стоял (законно) или часы ушли вперёд. Считаем по часам, но
  // максимум виденного двигаем на 48 ч и не чаще раза в час — после починки часов лицензия снова идёт по ним.
  // realAt идёт только по монотонному времени: шаг вперёд в него не входит.
  const canStep = clock < step || clock - step >= CLOCK_JUMP_STEP_INTERVAL_MS;
  const seen = canStep ? lastSeenAt + CLOCK_MAX_STEP_MS : lastSeenAt;
  return calm(clock, seen, canStep ? clock : step, Math.min(seen, real0 + byMono), 'forward', canStep, mono);
}

function calm(now: number, lastSeenAt: number, lastStepAt: number, realAt: number, jump: ClockJump, stepped: boolean, mono: number): ClockResult {
  return { now, lastSeenAt, lastStepAt, realAt, behind: null, jump, stepped, behindForMs: 0, locked: false, alert: false, anchor: { mono, realAt } };
}
