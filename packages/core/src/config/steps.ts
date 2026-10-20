// Шаги времени в настройках (CONFIG §3.3, §6.5–6.9): `+2h`, `+30m`, `nextWorkday@10:00`,
// `nextEvent:<тип мероприятия>@10:00`. Здесь только разбор; считает момент рабочий календарь (core/time).

export type Step =
  | { kind: 'plus'; minutes: number }
  | { kind: 'nextWorkday'; time: string }
  | { kind: 'nextEvent'; eventTypeKey: string; time: string };

export type StepKind = Step['kind'];

/** Верхняя граница сдвига `+N`: 30 суток. */
export const STEP_MAX_MINUTES = 30 * 24 * 60;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** Разбор шага или null, если строка не шаг. */
export function parseStep(s: string): Step | null {
  let m = /^\+([1-9]\d{0,5})([hm])$/.exec(s);
  if (m) {
    const minutes = Number(m[1]) * (m[2] === 'h' ? 60 : 1);
    return minutes <= STEP_MAX_MINUTES ? { kind: 'plus', minutes } : null;
  }
  m = /^nextWorkday@(\d\d:\d\d)$/.exec(s);
  if (m && HHMM.test(m[1] as string)) return { kind: 'nextWorkday', time: m[1] as string };
  m = /^nextEvent:([a-z0-9_]+)@(\d\d:\d\d)$/.exec(s);
  if (m && KEY.test(m[1] as string) && HHMM.test(m[2] as string)) return { kind: 'nextEvent', eventTypeKey: m[1] as string, time: m[2] as string };
  return null;
}
