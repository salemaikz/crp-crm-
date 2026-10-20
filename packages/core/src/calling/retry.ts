// Расписание повторов недозвона (PROCESS §3.4, CONFIG §6.6 `calling.retry`).
// Чистая логика: календарь компании приходит параметром `WorkCalendar` (реализация — core/time),
// время — параметром, шаги и число попыток — из настроек. Правило перехода карточки
// (`applyOutcome`) вызывает `planNoAnswer` и не знает формата шагов.
// Источник идеи: SalemAI 108fb70 src/lib/crm/coldCall.ts (nextRetryAt; часы и интервалы там
// были константами, здесь — настройки).

import type { HHMM, Ms, WorkCalendar } from './spec/types.js';

/** Разобранный шаг: сдвиг от момента недозвона или «следующий рабочий день в HH:MM». */
export type RetryStep =
  | { kind: 'shift'; ms: Ms }
  | { kind: 'nextWorkday'; hhmm: HHMM };

const SHIFT = /^\+([1-9]\d{0,3})([hm])$/;
const NEXT_WORKDAY = /^nextWorkday@([01]\d|2[0-3]):([0-5]\d)$/;

/** Разбор шага `+Nh`, `+Nm`, `nextWorkday@HH:MM`; `null` — формат неверный. */
export function parseRetryStep(step: string): RetryStep | null {
  const s = SHIFT.exec(step);
  if (s) return { kind: 'shift', ms: Number(s[1]) * (s[2] === 'h' ? 3_600_000 : 60_000) };
  const w = NEXT_WORKDAY.exec(step);
  if (w) return { kind: 'nextWorkday', hhmm: `${w[1]}:${w[2]}` };
  return null;
}

export type RetrySettings = { steps: readonly string[]; maxAttempts: number };

/**
 * Проверка настроек повторов (дубль проверки схемы конфига, CONFIG §3.3): `maxAttempts` 1–10,
 * каждый шаг разбирается, шагов не меньше `maxAttempts − 1`. Возвращает список ошибок.
 */
export function validateRetrySettings(r: RetrySettings): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > 10) {
    errors.push('maxAttempts: целое от 1 до 10');
  }
  r.steps.forEach((s, i) => {
    if (!parseRetryStep(s)) errors.push(`steps[${i}]: неверный шаг «${s}»`);
  });
  if (r.steps.length < r.maxAttempts - 1) errors.push('steps: шагов меньше, чем maxAttempts − 1');
  return errors;
}

/**
 * Срок обычного шага (`noShow.callbackAt`, `nextStep.taskAt`): сдвиг от `from` без окна звонков
 * или `nextWorkday@HH:MM`. Тот же разборщик, что у повторов; неверный формат — `RangeError`.
 */
export function resolveStepAt(step: string, from: Ms, calendar: WorkCalendar): Ms {
  const parsed = parseRetryStep(step);
  if (!parsed) throw new RangeError(`неверный шаг срока «${step}»`);
  return parsed.kind === 'shift' ? from + parsed.ms : calendar.nextWorkdayAt(from, parsed.hhmm);
}

/**
 * Время из шага повтора. `+Nh/+Nm`: сдвиг от `from`; если результат вне окна звонков рабочего дня,
 * срок = первое `hhmm` рабочего дня после него. `hhmm` берётся из первого шага
 * `nextWorkday@…` списка, а если его нет — из `calendar.callWindowStart` (PROCESS 3.4).
 * `nextWorkday@HH:MM`: HH:MM первого рабочего дня строго после местных суток `from`.
 */
export function resolveRetryStep(
  step: string,
  from: Ms,
  calendar: WorkCalendar,
  steps: readonly string[] = [],
): Ms {
  const parsed = parseRetryStep(step);
  if (!parsed) throw new RangeError(`calling.retry: неверный шаг «${step}»`);
  if (parsed.kind === 'nextWorkday') return calendar.nextWorkdayAt(from, parsed.hhmm);
  const shifted = from + parsed.ms;
  if (calendar.isInCallWindow(shifted)) return shifted;
  return calendar.nextWorkdayTimeAfter(shifted, shiftedIntoWindowTime(steps, calendar));
}

/** Время для сдвига вне окна: первый `nextWorkday@HH:MM` списка шагов, иначе начало окна. */
function shiftedIntoWindowTime(steps: readonly string[], calendar: WorkCalendar): HHMM {
  for (const s of steps) {
    const p = parseRetryStep(s);
    if (p?.kind === 'nextWorkday') return p.hhmm;
  }
  return calendar.callWindowStart;
}

export type NoAnswerPlan =
  /** Следующая попытка: `attempts` станет `attempts`, `nextCallAt` — срок. */
  | { kind: 'retry'; attempts: number; nextCallAt: Ms }
  /** Лимит недозвонов: карточка «Списан», причина `no_answer_limit`. */
  | { kind: 'write_off'; attempts: number };

/**
 * План после очередного недозвона. `attemptsBefore` — счётчик до этого звонка. Номер попытки
 * `k = attemptsBefore + 1`: `k ≥ maxAttempts` → списание, иначе срок по шагу `steps[k − 1]`
 * от `occurredAt` (времени звонка, не приёма: офлайн-итог, 12.3).
 * Если шагов меньше, чем нужно (настройки не прошли проверку) — используется последний шаг.
 */
export function planNoAnswer(
  attemptsBefore: number,
  occurredAt: Ms,
  retry: RetrySettings,
  calendar: WorkCalendar,
): NoAnswerPlan {
  const k = attemptsBefore + 1;
  if (k >= retry.maxAttempts) return { kind: 'write_off', attempts: k };
  if (retry.steps.length === 0) throw new RangeError('calling.retry.steps пуст при maxAttempts > 1');
  const step = retry.steps[Math.min(k - 1, retry.steps.length - 1)]!;
  return {
    kind: 'retry',
    attempts: k,
    nextCallAt: resolveRetryStep(step, occurredAt, calendar, retry.steps),
  };
}
