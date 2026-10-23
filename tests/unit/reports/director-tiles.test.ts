// Плитки панели директора (R1, §11.1): набор, порядок, сравнение с прошлой неделей, подписи из настроек.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventShortLabels } from '../../../src/server/domain/reports/director';
import { delta, directorTiles, type TileSpec } from '../../../src/app/(mgr)/director/tiles';
import type { DirectorData } from '../../../src/app/(mgr)/director/types';

const data = {
  calls: { outcomes: 40, connects: 12, prevOutcomes: 30, prevConnects: 12 },
  bookings: { groups: 5, consults: 2 },
  eventLabels: { group: 'АБ', individual: 'ВГ' },
  attendance: { attended: 3, noShow: 1, rate: 75 },
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
  assert.equal(directorTiles(none).find((x) => x.id === 'conversion')?.rate, null);
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
