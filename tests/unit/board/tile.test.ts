// Что показывает плитка: тон по пресету, значки, чип и срок (pipeline-v2 §5.3, §9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgesOf, chipOf, dueOf, hasFire, overdueParts, toneOf } from '@/ui/board/tile';
import { card } from './fixtures';

const TONES = [
  { when: 'attendedIndividual', tone: 'warning' },
  { when: 'attendedGroup', tone: 'success' },
];

test('тон плитки: был на встрече — зелёный, был на консультации — жёлтый (из пресета)', () => {
  assert.equal(toneOf(card({ flags: { attendedGroup: true, attendedIndividual: false, noShow: false } }), TONES), 'success');
  assert.equal(toneOf(card({ flags: { attendedGroup: false, attendedIndividual: true, noShow: false } }), TONES), 'warning');
});

test('тон: действует первое совпадение; без признаков и без пресета цвета нет', () => {
  const both = card({ flags: { attendedGroup: true, attendedIndividual: true, noShow: false } });
  assert.equal(toneOf(both, TONES), 'warning');
  assert.equal(toneOf(card(), TONES), null);
  assert.equal(toneOf(both, []), null);
});

test('тон: неизвестное имя тона и неизвестное условие пропускаются; покупка — только если сервер прислал признак', () => {
  const att = card({ flags: { attendedGroup: true, attendedIndividual: false, noShow: false } });
  assert.equal(toneOf(att, [{ when: 'attendedGroup', tone: '#ff0000' }, { when: 'wat', tone: 'info' }]), null);
  assert.equal(toneOf(card({ purchases: { total: 1, lastAt: 1 } }), [{ when: 'purchased', tone: 'info' }]), 'info');
  assert.equal(toneOf(card(), [{ when: 'purchased', tone: 'info' }]), null);
});

test('значки: покупки только при признаке от сервера (нет права — ключа нет), «не пришёл» отдельно', () => {
  assert.deepEqual(badgesOf(card()), []);
  assert.deepEqual(badgesOf(card({ purchases: { total: 0, lastAt: null } })), []);
  assert.deepEqual(badgesOf(card({ purchases: { total: 2, lastAt: 5 }, flags: { attendedGroup: true, attendedIndividual: false, noShow: true } })), ['attendedGroup', 'purchased', 'noShow']);
});

test('чип: причина и касание, недозвон, запись, состояние; у нового клиента чипа нет', () => {
  assert.deepEqual(chipOf(card({ state: 'callback', callbackReason: 'think', callbackTouches: 2 })), { kind: 'reason', reason: 'think', touches: 2 });
  assert.deepEqual(chipOf(card({ state: 'retry', attempts: 2 })), { kind: 'attempts', n: 2 });
  assert.deepEqual(chipOf(card({ state: 'agreed', event: { type: 'g', status: 'registered', startsAt: 5 } })), { kind: 'event', type: 'g', status: 'registered', startsAt: 5 });
  assert.deepEqual(chipOf(card({ state: 'callback' })), { kind: 'state', state: 'callback' });
  assert.deepEqual(chipOf(card({ state: 'client' })), { kind: 'state', state: 'client' });
  assert.deepEqual(chipOf(card()), { kind: 'none' });
});

test('срок: просрочка и «сегодня» берутся от сервера, «без времени» сохраняется', () => {
  const now = 10 * 3_600_000;
  assert.deepEqual(dueOf(card(), now), { kind: 'none' });
  assert.deepEqual(dueOf(card({ nextCallAt: now - 2 * 3_600_000, fire: 'overdue' }), now), { kind: 'overdue', precision: 'time', at: now - 7_200_000, minutes: 120 });
  assert.equal(dueOf(card({ nextCallAt: now + 1, fire: 'today', nextCallPrecision: 'day' }), now).kind, 'today');
  assert.equal(dueOf(card({ nextCallAt: now + 1e9, fire: null }), now).kind, 'later');
});

test('огонёк: сегодня и просрочено; остальное без огонька', () => {
  assert.equal(hasFire(card({ fire: 'today' })), true);
  assert.equal(hasFire(card({ fire: 'overdue' })), true);
  assert.equal(hasFire(card({ fire: null })), false);
});

test('просрочка словами: минуты, часы, дни', () => {
  assert.deepEqual(overdueParts(35), { unit: 'min', n: 35 });
  assert.deepEqual(overdueParts(120), { unit: 'hour', n: 2 });
  assert.deepEqual(overdueParts(60 * 24 * 3), { unit: 'day', n: 3 });
});
