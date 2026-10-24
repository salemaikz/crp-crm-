// Плитки панели директора (R1, §11.1): набор, порядок, сравнение с прошлой неделей, подписи из настроек.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventShortLabels } from '../../../src/server/domain/reports/director';
import { delta, directorTiles, funnelHints, type TileSpec } from '../../../src/app/(mgr)/director/tiles';
import type { DirectorData } from '../../../src/app/(mgr)/director/types';

const data = {
  calls: { outcomes: 40, connects: 12, prevOutcomes: 30, prevConnects: 12 },
  bookings: { groups: 5, consults: 2 },
  eventLabels: { group: 'АБ', individual: 'ВГ' },
  attendance: { attended: 3, noShow: 1, rate: 75, unmarked: 2 },
  purchases: { count: 2, sumKzt: 100000, prevCount: 1, prevSumKzt: 50000 },
  conversion: { average: 22.5, team: 20, operators: 3, minConnects: 20 },
  stock: { poolReady: 321, capacityPerDay: 80, days: 4 },
} as unknown as DirectorData;

test('delta: рост, падение, ноль, прошлая неделя без данных', () => {
  assert.deepEqual(delta(40, 30), { sign: 'up', abs: 10 });
  assert.deepEqual(delta(5, 9), { sign: 'down', abs: 4 });
  assert.deepEqual(delta(7, 7), { sign: 'same', abs: 0 });
});

test('плитки: итоги и дозвоны отдельно, записи по видам, «В пуле»', () => {
  const ids: string[] = directorTiles(data).map((x) => x.id);
  assert.deepEqual(ids.slice(0, 4), ['outcomes', 'connects', 'bookGroup', 'bookIndividual']);
  assert.ok(ids.includes('pool'));
  assert.ok(!ids.includes('calls') && !ids.includes('bookings') && !ids.includes('stock'));
  const all = directorTiles(data);
  const t = (id: string): TileSpec => all.find((x) => x.id === id) as TileSpec;
  assert.equal(t('outcomes').value, 40);
  assert.equal(t('outcomes').prev, 30);
  assert.equal(t('connects').value, 12);
  assert.equal(t('bookGroup').value, 5);
  assert.equal(t('bookGroup').label, 'АБ');
  assert.equal(t('bookIndividual').label, 'ВГ');
  assert.equal(t('pool').value, 321);
  // средняя конверсия операторов: доля, а не счёт; перед «В пуле»
  assert.equal(t('conversion').rate, 22.5);
  assert.ok(ids.indexOf('conversion') < ids.indexOf('pool'));
});

test('плитка средней конверсии: нет операторов с нужным числом дозвонов — доли нет', () => {
  const none = { ...data, conversion: { average: null, team: null, operators: 0, minConnects: 20 } } as unknown as DirectorData;
  const tile = directorTiles(none).find((x) => x.id === 'conversion');
  assert.equal(tile?.rate, null);
  assert.equal(tile?.lowData, true, 'вместо прочерка — текст «Пока мало данных» с порогом');
  assert.equal(directorTiles(data).find((x) => x.id === 'conversion')?.lowData, false);
});

test('плитка «Явка»: неотмеченные записи выводятся отдельным числом', () => {
  const a = directorTiles(data).find((x) => x.id === 'attendance');
  assert.equal(a?.unmarked, 2);
  assert.equal(a?.value, 3);
});

test('eventShortLabels: первый групповой и первый индивидуальный вид, подписи short', () => {
  const l = eventShortLabels([
    { key: 'x', behavior: 'group', short: { ru: 'Г1' }, label: { ru: 'Группа 1' } },
    { key: 'y', behavior: 'individual', short: { ru: 'И1' }, label: { ru: 'Инд 1' } },
    { key: 'z', behavior: 'group', short: { ru: 'Г2' }, label: { ru: 'Группа 2' } },
  ]);
  assert.deepEqual(l, { group: 'Г1', individual: 'И1' });
  assert.deepEqual(eventShortLabels([{ key: 'k', behavior: 'individual', label: { ru: 'Консультация' } }]), { group: '', individual: 'Консультация' });
  assert.deepEqual(eventShortLabels([]), { group: '', individual: '' });
});

test('локаль панели: подписи видов — шаблон с подстановкой, без терминов клиента', () => {
  const ru = JSON.parse(readFileSync('messages/ru/reports.json', 'utf8')).director.tiles;
  assert.match(ru.bookGroup.title, /\{event\}/);
  assert.match(ru.bookIndividual.title, /\{event\}/);
  assert.ok(ru.outcomes && ru.connects && ru.pool && ru.conversion);
  assert.match(ru.conversion.hint, /\{teamRate\}/);
  assert.ok(!('calls' in ru) && !('bookings' in ru) && !('stock' in ru));
  assert.doesNotMatch(JSON.stringify(ru), /БР|БК|разбор/i);
});

const funnelData = (counts: Partial<Record<'issued' | 'connected' | 'lpr' | 'booked' | 'attended' | 'purchased', number>>, rates: Record<string, number | null>, att: { attended: number; noShow: number; rate: number | null }, withoutBooking = 0) =>
  ({
    funnel: { counts: { issued: 0, connected: 0, lpr: 0, booked: 0, attended: 0, purchased: 0, ...counts }, rates },
    attendance: att,
    purchases: { count: counts.purchased ?? 0, withoutBooking },
  }) as unknown as DirectorData;

test('воронка директора: «Пришли» показывает ту же явку, что плитка; доля выше 100 % не выводится', () => {
  const d = funnelData({ booked: 10, attended: 2, purchased: 4 }, { connected: null, lpr: null, booked: null, attended: 20, purchased: 200 }, { attended: 2, noShow: 2, rate: 50 }, 1);
  const h = funnelHints(d);
  assert.deepEqual(h.attended, { kind: 'attendance', value: 50 });
  assert.deepEqual(h.purchased, { kind: 'none' });
  assert.equal(h.note, true, 'покупок больше явок — нужна сноска про воронку периода');
  assert.equal(h.withoutBooking, 1);
});

test('воронка директора: согласованная воронка — доли шагов как есть, сноски нет', () => {
  const d = funnelData({ booked: 10, attended: 4, purchased: 2 }, { connected: 50, lpr: 40, booked: 80, attended: 40, purchased: 50 }, { attended: 4, noShow: 1, rate: 80 });
  const h = funnelHints(d);
  assert.deepEqual([h.connected, h.booked, h.purchased], [{ kind: 'rate', value: 50, from: 'issued' }, { kind: 'rate', value: 80, from: 'lpr' }, { kind: 'rate', value: 50, from: 'attended' }]);
  assert.deepEqual([h.note, h.withoutBooking], [false, 0]);
});

test('воронка директора: доля шага названа от предыдущего шага («от «Выдано»»)', () => {
  const d = funnelData({ issued: 100, connected: 50, lpr: 40, booked: 32, attended: 20, purchased: 10 }, { connected: 50, lpr: 80, booked: 80, attended: 62.5, purchased: 50 }, { attended: 20, noShow: 5, rate: 80 });
  const h = funnelHints(d);
  assert.deepEqual([h.connected, h.lpr, h.booked, h.purchased].map((x) => (x.kind === 'rate' ? x.from : null)), ['issued', 'connected', 'lpr', 'attended']);
});

test('локаль панели: «Пока мало данных», «не отмечено», «от «…»» без терминов клиента', () => {
  const ru = JSON.parse(readFileSync('messages/ru/reports.json', 'utf8')).director;
  assert.match(ru.tiles.conversion.empty, /Пока мало данных/);
  assert.match(ru.tiles.conversion.emptyHint, /\{min\}/);
  assert.match(ru.tiles.attendance.hint, /\{unmarked\}/);
  assert.match(ru.funnel.ofPrev, /\{pct\}.*\{prev\}/);
});
