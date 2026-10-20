/**
 * Серии групповых мероприятий (PROCESS §5.1): генерация на горизонт, пропуск праздников,
 * перегенерация только нетронутых, идемпотентность.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { occurrenceKey, planSeriesSync, seriesOccurrences, type ExistingEvent } from './series';
import { localToEpoch } from './time';
import type { EventSeries } from './types';
import { TZ, testCalendar } from './fixtures';

// Серия «четверг 15:00, 180 минут, офлайн, 30 мест»; тип мероприятия — произвольный ключ из настроек.
const SERIES: EventSeries = {
  id: 's1', eventTypeKey: 'group_event', weekday: 4, startTime: '15:00', durationMin: 180, location: 'зал 1', format: 'offline',
  capacity: 30, active: true,
};
const NOW = localToEpoch(TZ, '2026-10-20', '10:00'); // вторник
const base = { tz: TZ, now: NOW, horizonDays: 28, isWorkday: testCalendar().isWorkday };
const dates = (xs: { eventDate: string }[]) => xs.map((x) => x.eventDate);

test('28 дней вперёд: четыре четверга, время и ключи на месте', () => {
  const { occurrences, skipped } = seriesOccurrences(SERIES, base);
  assert.deepEqual(dates(occurrences), ['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12']);
  assert.deepEqual(skipped, []);
  const first = occurrences[0]!;
  assert.equal(first.occurrenceKey, 's1:2026-10-22');
  assert.equal(new Date(first.startsAt).toISOString(), '2026-10-22T10:00:00.000Z', '15:00 по Алматы');
  assert.deepEqual([first.durationMin, first.capacity, first.location, first.format], [180, 30, 'зал 1', 'offline']);
});

test('праздник в день серии пропускается и попадает в список пропусков', () => {
  const isWorkday = testCalendar([{ date: '2026-11-05', kind: 'holiday' }]).isWorkday;
  const { occurrences, skipped } = seriesOccurrences(SERIES, { ...base, isWorkday });
  assert.deepEqual(dates(occurrences), ['2026-10-22', '2026-10-29', '2026-11-12']);
  assert.deepEqual(skipped, [{ date: '2026-11-05', reason: 'non_workday' }]);
});

test('серия по субботе: перенесённый рабочий день не пропускается, обычная суббота — да', () => {
  const sat = { ...SERIES, weekday: 6 };
  const isWorkday = testCalendar([{ date: '2026-10-31', kind: 'workday' }]).isWorkday;
  const { occurrences, skipped } = seriesOccurrences(sat, { ...base, isWorkday });
  assert.deepEqual(dates(occurrences), ['2026-10-31']);
  assert.deepEqual(skipped.map((s) => s.date), ['2026-10-24', '2026-11-07', '2026-11-14']);
});

test('сегодняшнее, но уже начавшееся мероприятие не создаётся; ещё не начавшееся — создаётся', () => {
  const after = localToEpoch(TZ, '2026-10-22', '15:00');
  assert.deepEqual(dates(seriesOccurrences(SERIES, { ...base, now: after }).occurrences)[0], '2026-10-29');
  const before = localToEpoch(TZ, '2026-10-22', '14:59');
  assert.deepEqual(dates(seriesOccurrences(SERIES, { ...base, now: before }).occurrences)[0], '2026-10-22');
});

test('горизонт — настройка: 14 дней дают два четверга; выключенная серия не порождает ничего', () => {
  assert.deepEqual(dates(seriesOccurrences(SERIES, { ...base, horizonDays: 14 }).occurrences), ['2026-10-22', '2026-10-29']);
  assert.deepEqual(seriesOccurrences({ ...SERIES, active: false }, base), { occurrences: [], skipped: [] });
});

test('граница суток: в 23:30 UTC по Алматы уже следующий день, горизонт считается от него', () => {
  const now = Date.parse('2026-10-21T23:30:00.000Z'); // 22.10 04:30 по Алматы
  assert.equal(dates(seriesOccurrences(SERIES, { ...base, now }).occurrences)[0], '2026-10-22');
});

function existing(date: string, p: Partial<ExistingEvent> = {}): ExistingEvent {
  const startsAt = localToEpoch(TZ, date, '15:00');
  return {
    id: `e-${date}`, seriesId: 's1', eventTypeKey: 'group_event', eventDate: date, startTime: '15:00', startsAt, durationMin: 180,
    location: 'зал 1', format: 'offline', capacity: 30, status: 'scheduled', occurrenceKey: occurrenceKey('s1', date), touched: false,
    bookingCount: 0, dutyCount: 0, ...p,
  };
}

test('повторный прогон идемпотентен: всё уже создано — ничего не делаем', () => {
  const have = ['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12'].map((d) => existing(d));
  assert.deepEqual(planSeriesSync(SERIES, have, base), { create: [], update: [], remove: [], skipped: [] });
});

test('создаются только недостающие', () => {
  const plan = planSeriesSync(SERIES, [existing('2026-10-22'), existing('2026-10-29')], base);
  assert.deepEqual(dates(plan.create), ['2026-11-05', '2026-11-12']);
});

test('правка серии: нетронутые будущие обновляются, с записями/дежурными/ручной правкой — нет', () => {
  const edited = { ...SERIES, startTime: '16:00', capacity: 40 };
  const have = [
    existing('2026-10-22'),
    existing('2026-10-29', { bookingCount: 3 }),
    existing('2026-11-05', { touched: true }),
    existing('2026-11-12', { dutyCount: 1 }),
  ];
  const plan = planSeriesSync(edited, have, base);
  assert.deepEqual(plan.update.map((u) => u.id), ['e-2026-10-22']);
  const changes = plan.update[0]!.changes;
  assert.equal(changes.startTime, '16:00');
  assert.equal(changes.capacity, 40);
  assert.equal(changes.startsAt, localToEpoch(TZ, '2026-10-22', '16:00'));
  assert.equal('location' in changes, false, 'не менялось — не трогаем');
  assert.deepEqual(plan.create, []);
});

test('отменённое мероприятие не возвращается и не обновляется', () => {
  const edited = { ...SERIES, capacity: 40 };
  const cancelled = existing('2026-10-22', { status: 'cancelled' });
  const plan = planSeriesSync(edited, [cancelled, existing('2026-10-29'), existing('2026-11-05'), existing('2026-11-12')], base);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.update.map((u) => u.id), ['e-2026-10-29', 'e-2026-11-05', 'e-2026-11-12']);
});

test('смена дня недели: нетронутые старые уходят, с записями остаются, новые создаются', () => {
  const moved = { ...SERIES, weekday: 3 }; // среда
  const have = [existing('2026-10-22'), existing('2026-10-29', { bookingCount: 2 }), existing('2026-11-05')];
  const plan = planSeriesSync(moved, have, base);
  assert.deepEqual(plan.remove, ['e-2026-10-22', 'e-2026-11-05']);
  assert.deepEqual(dates(plan.create), ['2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11']);
});

test('новый праздник в день серии: пустое мероприятие убирается, с записями — остаётся (решает РОП)', () => {
  const isWorkday = testCalendar([{ date: '2026-10-29', kind: 'holiday' }, { date: '2026-11-05', kind: 'holiday' }]).isWorkday;
  const have = ['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12'].map((d) => existing(d, d === '2026-11-05' ? { bookingCount: 1 } : {}));
  const plan = planSeriesSync(SERIES, have, { ...base, isWorkday });
  assert.deepEqual(plan.remove, ['e-2026-10-29']);
  assert.deepEqual(plan.skipped.map((s) => s.date), ['2026-10-29', '2026-11-05']);
});

test('выключили серию: нетронутые будущие убираются, прошлые и за горизонтом не трогаются', () => {
  const have = [existing('2026-10-15'), existing('2026-10-22'), existing('2026-12-10')];
  const plan = planSeriesSync({ ...SERIES, active: false }, have, base);
  assert.deepEqual(plan.remove, ['e-2026-10-22']);
});
