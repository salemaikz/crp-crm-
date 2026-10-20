/**
 * Напоминания: кому напомнить сегодня и какой текст отправить.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/reminders.ts (`reminderBucket`, `reminderDates`).
 *
 * ПРАВИЛО (PROCESS §5.4): в списке «Напомнить» — записи в статусе registered на СЕГОДНЯ (ещё не
 * началось) и ЗАВТРА; «серые» консультации на сегодня — тем же правилом. Подтвердившие,
 * отменившие и перенесённые из списка уходят. Какие корзины показывать — `reminders.days`.
 *
 * Текст — шаблон из настроек `reminders.templates[]` с подстановками только из белого списка
 * {name} {date} {time} {place}. Чужие плейсхолдеры при проверке настроек отвергаются
 * (`unknownPlaceholders`), при подстановке остаются как есть: текст клиенту не должен тихо
 * терять слова. Подстановка однопроходная: значения не разбираются повторно.
 */

import type { BookingStatus, ReminderDay, ReminderTemplate } from './types';
import { addDays, epochToLocalDate, type Tz } from './time';

export type ReminderBucket = ReminderDay;

export interface ReminderCandidate {
  status: BookingStatus;
  bookingDate: string;
  startsAt: number;
}

/** Корзина напоминания или null. `days` — `reminders.days`; по умолчанию обе корзины. */
export function reminderBucket(
  c: ReminderCandidate,
  now: number,
  tz: Tz,
  days: readonly ReminderDay[] = ['today', 'tomorrow'],
): ReminderBucket | null {
  if (c.status !== 'registered') return null;
  const today = epochToLocalDate(tz, now);
  let bucket: ReminderBucket | null = null;
  if (c.bookingDate === today) bucket = c.startsAt > now ? 'today' : null;
  else if (c.bookingDate === addDays(today, 1)) bucket = 'tomorrow';
  return bucket && days.includes(bucket) ? bucket : null;
}

/** Даты, по которым репозиторий выбирает кандидатов. */
export function reminderDates(now: number, tz: Tz): { today: string; tomorrow: string } {
  const today = epochToLocalDate(tz, now);
  return { today, tomorrow: addDays(today, 1) };
}

export const REMINDER_PLACEHOLDERS = ['name', 'date', 'time', 'place'] as const;
export type ReminderPlaceholder = (typeof REMINDER_PLACEHOLDERS)[number];

export type ReminderVars = Record<ReminderPlaceholder, string>;

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** Плейсхолдеры шаблона вне белого списка (для проверки настроек). */
export function unknownPlaceholders(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const name = m[1] ?? '';
    if (!(REMINDER_PLACEHOLDERS as readonly string[]).includes(name)) bad.add(name);
  }
  return [...bad];
}

/** Подставляет значения в шаблон; неизвестные плейсхолдеры не трогает. */
export function renderReminder(text: string, vars: ReminderVars): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    (REMINDER_PLACEHOLDERS as readonly string[]).includes(name) ? vars[name as ReminderPlaceholder] : whole,
  );
}

/** Шаблон вида мероприятия; нет своего — общий (eventTypeKey пуст); нет и его — null. */
export function pickReminderTemplate(templates: readonly ReminderTemplate[], eventTypeKey: string): ReminderTemplate | null {
  return (
    templates.find((t) => t.eventTypeKey === eventTypeKey) ??
    templates.find((t) => t.eventTypeKey === '') ??
    null
  );
}

/** Дата для текста клиенту: 'YYYY-MM-DD' → 'ДД.ММ'. */
export function formatReminderDate(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/** Подстановки из записи: имя, дата ДД.ММ, время, место. Пустое имя заменяется `fallbackName`. */
export function buildReminderVars(
  b: { clientName: string; bookingDate: string; startTime: string; place: string },
  fallbackName: string,
): ReminderVars {
  return {
    name: b.clientName.trim() || fallbackName,
    date: formatReminderDate(b.bookingDate),
    time: b.startTime,
    place: b.place.trim(),
  };
}
