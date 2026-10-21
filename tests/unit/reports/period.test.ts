// Период отчёта (R3a, D-261): границы суток Asia/Almaty, длина, неделя с понедельника, корзины.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../../src/server/access';
import { bucketOf, defaultPeriod, diffDays, previousWeek, resolvePeriod, weekOf } from '../../../src/server/domain/reports/period';

const TZ = 'Asia/Almaty'; // UTC+5
const at = (iso: string) => Date.parse(iso);

function periodInvalid(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof BadRequestError && e.detail === 'period_invalid');
}

test('границы: местные сутки от 00:00 первого дня до 00:00 дня после последнего', () => {
  const p = resolvePeriod({ from: '2026-10-26', to: '2026-10-28' }, TZ);
  assert.equal(p.fromMs, at('2026-10-25T19:00:00Z'));
  assert.equal(p.toMs, at('2026-10-28T19:00:00Z'));
  assert.equal(p.days, 3);
  assert.equal(p.timeZone, TZ);
});

test('граница суток: 23:30 и 00:30 местного времени попадают в разные дни', () => {
  const p = resolvePeriod({ from: '2026-10-27', to: '2026-10-27' }, TZ);
  const late = at('2026-10-27T18:30:00Z'); // 23:30 по Алматы 27-го
  const early = at('2026-10-27T19:30:00Z'); // 00:30 по Алматы 28-го
  assert.ok(late >= p.fromMs && late < p.toMs);
  assert.ok(!(early >= p.fromMs && early < p.toMs));
});

test('длина: 92 дня можно, 93 — нельзя', () => {
  assert.equal(resolvePeriod({ from: '2026-07-01', to: '2026-09-30' }, TZ).days, 92);
  periodInvalid(() => resolvePeriod({ from: '2026-07-01', to: '2026-10-01' }, TZ));
});

test('формат и порядок: нечисла, несуществующая дата, from > to', () => {
  periodInvalid(() => resolvePeriod({ from: '28.10.2026', to: '2026-10-28' }, TZ));
  periodInvalid(() => resolvePeriod({ from: '2026-02-30', to: '2026-03-01' }, TZ));
  periodInvalid(() => resolvePeriod({ from: '2026-10-29', to: '2026-10-28' }, TZ));
});

test('будущее: конец завтра можно, послезавтра — нельзя (с часами)', () => {
  const now = at('2026-10-28T07:00:00Z'); // 12:00 по Алматы
  assert.equal(resolvePeriod({ from: '2026-10-28', to: '2026-10-29' }, TZ, now).days, 2);
  periodInvalid(() => resolvePeriod({ from: '2026-10-28', to: '2026-10-30' }, TZ, now));
  // 02:00 по Алматы 29-го ещё «вчера» по UTC: сегодня считается по поясу установки
  const nightLocal = at('2026-10-28T21:00:00Z');
  assert.equal(resolvePeriod({ from: '2026-10-29', to: '2026-10-30' }, TZ, nightLocal).days, 2);
  periodInvalid(() => resolvePeriod({ from: '2026-10-29', to: '2026-10-31' }, TZ, nightLocal));
});

test('неделя начинается с понедельника; по умолчанию — понедельник … сегодня', () => {
  assert.equal(weekOf('2026-10-28'), '2026-10-26'); // среда
  assert.equal(weekOf('2026-10-26'), '2026-10-26'); // понедельник
  assert.equal(weekOf('2026-11-01'), '2026-10-26'); // воскресенье
  assert.deepEqual(defaultPeriod('2026-10-28'), { from: '2026-10-26', to: '2026-10-28' });
  assert.deepEqual(previousWeek('2026-10-28'), { from: '2026-10-19', to: '2026-10-25' });
});

test('корзины: всего, день, понедельник недели', () => {
  assert.equal(bucketOf('2026-10-28', 'total'), 'total');
  assert.equal(bucketOf('2026-10-28', 'day'), '2026-10-28');
  assert.equal(bucketOf('2026-10-28', 'week'), '2026-10-26');
  assert.equal(bucketOf('2026-11-01', 'week'), '2026-10-26');
  assert.equal(bucketOf('2026-11-02', 'week'), '2026-11-02');
});

test('diffDays: через границу месяца и года', () => {
  assert.equal(diffDays('2026-10-31', '2026-11-02'), 2);
  assert.equal(diffDays('2025-12-31', '2026-01-01'), 1);
});
