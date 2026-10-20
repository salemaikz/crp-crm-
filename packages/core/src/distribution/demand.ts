// Спрос на день для `GET /api/ingest/v1/demand` (INTEGRATIONS 5.3, PROCESS 7.8, D-057): чистая формула.
// Сервер собирает числа из БД (операторы по дням, журнал выдач, пул, возвраты), эта функция их сводит.
// Все даты — местные сутки установки. В ответе нет ПДн.

import { isDistributionOver } from './schedule';
import type { DistributionCalendar, DistributionSchedule, LocalDay, Ms, Participant } from './types';

export interface DemandDay {
  date: LocalDay;
  /** Участники раздачи, работающие в этот день по календарю и отметкам «Отсутствует». */
  operators: number;
}

export interface DemandInput {
  now: Ms;
  calendar: DistributionCalendar;
  schedule: DistributionSchedule;
  /** `distribution.dailyCap`. */
  capPerOperator: number;
  /** `intake.bufferDays`. */
  bufferDays: number;
  /** Операторы сегодня: «Пауза» уже исключена (для будущих дней пауза не учитывается). */
  todayOperators: number;
  /** Выдачи за местные сутки, входящие в лимит (журнал). */
  issuedToday: number;
  /** Следующие `intake.demandWorkdays` рабочих дней после сегодня, по порядку. */
  days: readonly DemandDay[];
  /** Карточки «Не интересует», у которых `return_at` наступает в горизонте. */
  returnsExpected: number;
  /** Возвраты с `return_at` до конца указанных суток (включительно); для `next.returnsDue`. */
  returnsDueBy(day: LocalDay): number;
  /** Готовы к раздаче в пуле. */
  poolReady: number;
}

export interface DemandResult {
  today: {
    date: LocalDay;
    isWorkday: boolean;
    operators: number;
    capPerOperator: number;
    capacity: number;
    issued: number;
    remaining: number;
  };
  days: { date: LocalDay; operators: number; capacity: number }[];
  returnsExpected: number;
  poolReady: number;
  needToday: number;
  /** `null`, если рабочих дней впереди нет в горизонте. */
  next: { date: LocalDay; capacity: number; returnsDue: number } | null;
  bufferDays: number;
  needNext: number;
  needTotal: number;
}

const nat = (n: number) => Math.max(0, Math.trunc(n));

/** Округление вверх без плавающей ошибки (40 · 1,1 = 44,00000000000001). */
const ceilSafe = (x: number) => Math.ceil(Math.round(x * 1e6) / 1e6);

export function computeDemand(i: DemandInput): DemandResult {
  const date = i.calendar.localDay(i.now);
  const isWorkday = i.calendar.isWorkday(date);
  const operators = isWorkday ? nat(i.todayOperators) : 0;
  const capacity = operators * i.capPerOperator;
  const issued = nat(i.issuedToday);
  const remaining = Math.max(0, capacity - issued);

  const days = i.days.map((d) => ({ date: d.date, operators: nat(d.operators), capacity: nat(d.operators) * i.capPerOperator }));
  const poolReady = nat(i.poolReady);
  const returnsExpected = nat(i.returnsExpected);

  // 0 в нерабочий день: ночной приём в выходной не наращивает запас сверх буфера ближайшего дня.
  const needToday = isWorkday ? Math.max(0, remaining - poolReady) : 0;

  // Ближайший рабочий день D: сегодня, если день рабочий и раздача по расписанию ещё не закончилась.
  let next: DemandResult['next'] = null;
  if (isWorkday && !isDistributionOver(i.now, i.calendar, i.schedule)) {
    next = { date, capacity: remaining, returnsDue: nat(i.returnsDueBy(date)) };
  } else if (days[0]) {
    next = { date: days[0].date, capacity: days[0].capacity, returnsDue: nat(i.returnsDueBy(days[0].date)) };
  }
  const needNext = next ? Math.max(0, ceilSafe(next.capacity * (1 + i.bufferDays)) - next.returnsDue - poolReady) : 0;

  const sumDays = days.reduce((a, d) => a + d.capacity, 0);
  const needTotal = Math.max(0, remaining + sumDays - returnsExpected - poolReady);

  return {
    today: { date, isWorkday, operators, capPerOperator: i.capPerOperator, capacity, issued, remaining },
    days,
    returnsExpected,
    poolReady,
    needToday,
    next,
    bufferDays: i.bufferDays,
    needNext,
    needTotal,
  };
}

/** Сколько участников «работает» сегодня (для `todayOperators`): «Пауза» и «Отсутствует» не считаются. */
export function countWorkingOperators(participants: readonly Pick<Participant, 'status'>[]): number {
  return participants.filter((p) => p.status === 'working').length;
}
