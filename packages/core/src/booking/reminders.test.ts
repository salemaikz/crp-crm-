/**
 * «Кому напомнить сегодня» и текст напоминания по шаблону из настроек.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReminderVars, formatReminderDate, pickReminderTemplate, reminderBucket, reminderDates, renderReminder, unknownPlaceholders,
} from './reminders';
import { localToEpoch } from './time';
import { TZ } from './fixtures';

const START = localToEpoch(TZ, '2026-10-22', '15:00');
const T = (date: string, time: string) => localToEpoch(TZ, date, time);

test('среда: завтрашнее мероприятие — в список «завтра», подтвердившие и отменённые — нет', () => {
  const wednesday = T('2026-10-21', '10:00');
  const ev = { bookingDate: '2026-10-22', startsAt: START };
  assert.equal(reminderBucket({ ...ev, status: 'registered' }, wednesday, TZ), 'tomorrow');
  for (const status of ['confirmed', 'cancelled', 'moved', 'attended', 'no_show'] as const) {
    assert.equal(reminderBucket({ ...ev, status }, wednesday, TZ), null, status);
  }
});

test('записали в тот же день — подтвердить в тот же день, пока не началось', () => {
  const ev = { status: 'registered' as const, bookingDate: '2026-10-22', startsAt: START };
  assert.equal(reminderBucket(ev, T('2026-10-22', '09:00'), TZ), 'today');
  assert.equal(reminderBucket(ev, T('2026-10-22', '16:00'), TZ), null, 'началось — напоминать поздно');
});

test('послезавтра и прошлое в список не попадают', () => {
  const monday = T('2026-10-19', '10:00');
  assert.equal(reminderBucket({ status: 'registered', bookingDate: '2026-10-22', startsAt: START }, monday, TZ), null);
  assert.equal(reminderBucket({ status: 'registered', bookingDate: '2026-10-18', startsAt: START - 4 * 86_400_000 }, monday, TZ), null);
});

test('граница суток — по поясу настроек: в 23:30 UTC в Алматы уже «завтра»', () => {
  const now = Date.parse('2026-10-20T23:30:00.000Z'); // 21.10 04:30 по Алматы
  const ev = { status: 'registered' as const, bookingDate: '2026-10-22', startsAt: START };
  assert.equal(reminderBucket(ev, now, TZ), 'tomorrow');
  assert.equal(reminderBucket(ev, now, 'UTC'), null, 'по UTC это ещё 20.10, до 22.10 два дня');
  assert.deepEqual(reminderDates(now, TZ), { today: '2026-10-21', tomorrow: '2026-10-22' });
});

test('reminders.days: можно оставить только «завтра» или только «сегодня»', () => {
  const ev = { status: 'registered' as const, bookingDate: '2026-10-22', startsAt: START };
  assert.equal(reminderBucket(ev, T('2026-10-21', '10:00'), TZ, ['today']), null);
  assert.equal(reminderBucket(ev, T('2026-10-21', '10:00'), TZ, ['tomorrow']), 'tomorrow');
  assert.equal(reminderBucket(ev, T('2026-10-22', '09:00'), TZ, ['tomorrow']), null);
  assert.equal(reminderBucket(ev, T('2026-10-22', '09:00'), TZ, ['today']), 'today');
});

const TEXT = 'Здравствуйте, {name}! Напоминаем о встрече {date} в {time}, {place}. Подтверждаете участие?';
const VARS = { name: 'Алия', date: '29.10', time: '15:00', place: 'зал 2' };

test('подстановки {name} {date} {time} {place} из шаблона настроек', () => {
  assert.equal(renderReminder(TEXT, VARS), 'Здравствуйте, Алия! Напоминаем о встрече 29.10 в 15:00, зал 2. Подтверждаете участие?');
});

test('чужие плейсхолдеры: проверка настроек их находит, подстановка оставляет как есть', () => {
  assert.deepEqual(unknownPlaceholders(TEXT), []);
  assert.deepEqual(unknownPlaceholders('{name} {phone} {}'), ['phone', '']);
  assert.equal(renderReminder('{name}, {phone}', VARS), 'Алия, {phone}');
});

test('подстановка однопроходная: значение с фигурными скобками не разбирается повторно', () => {
  assert.equal(renderReminder('{name}|{time}', { ...VARS, name: '{time}' }), '{time}|15:00');
});

test('повторяющийся плейсхолдер подставляется везде', () => {
  assert.equal(renderReminder('{time}-{time}', VARS), '15:00-15:00');
});

test('шаблон вида мероприятия, иначе общий, иначе null', () => {
  const templates = [
    { key: 'general', eventTypeKey: '', text: 'общий' },
    { key: 'g', eventTypeKey: 'group_event', text: 'групповой' },
  ];
  assert.equal(pickReminderTemplate(templates, 'group_event')?.text, 'групповой');
  assert.equal(pickReminderTemplate(templates, 'consultation')?.text, 'общий');
  assert.equal(pickReminderTemplate([templates[1]!], 'consultation'), null);
});

test('подстановки из записи: дата ДД.ММ, пустое имя заменяется запасным', () => {
  assert.equal(formatReminderDate('2026-10-29'), '29.10');
  assert.deepEqual(buildReminderVars({ clientName: '  ', bookingDate: '2026-10-29', startTime: '15:00', place: ' зал 2 ' }, 'клиент'), {
    name: 'клиент', date: '29.10', time: '15:00', place: 'зал 2',
  });
});
