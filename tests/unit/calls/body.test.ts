// Тела и запросы маршрутов обзвона: Zod .strict(), границы (docs/calls-design.md §4.1, §8, §11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutcomeBody, QueueQuery, SkipBody } from '../../../src/app/api/calls/_lib';

const OP = '00000000-0000-4000-8000-000000000001';

const base = () => ({
  opId: OP,
  cardId: 'cd-a-1',
  outcomeKey: 'no_answer',
  via: 'ui',
  occurredAt: 1_793_000_000_000,
  tappedAt: null,
  phoneId: null,
  reasonCode: '',
  note: '',
  lpr: '',
  lprInfo: null,
  callbackAt: null,
  markTarget: false,
  alsoDncPhoneIds: [],
  fields: {},
  durationSec: null,
  agreement: null,
});

test('корректное тело проходит', () => {
  assert.ok(OutcomeBody.safeParse(base()).success);
});

test('лишнее поле → отказ (.strict())', () => {
  assert.equal(OutcomeBody.safeParse({ ...base(), extra: 1 }).success, false);
  assert.equal(OutcomeBody.safeParse({ ...base(), agreement: { contactId: null, agreedDueAt: null, booking: null, x: 1 } }).success, false);
});

test('границы: opId — uuid, время ≥ 0, заметка ≤ 2000, номера ≤ 10, поля ≤ 20 ключей', () => {
  assert.equal(OutcomeBody.safeParse({ ...base(), opId: 'не-uuid' }).success, false);
  assert.equal(OutcomeBody.safeParse({ ...base(), occurredAt: -1 }).success, false);
  assert.equal(OutcomeBody.safeParse({ ...base(), occurredAt: 1.5 }).success, false);
  assert.equal(OutcomeBody.safeParse({ ...base(), note: 'я'.repeat(2001) }).success, false);
  assert.ok(OutcomeBody.safeParse({ ...base(), note: 'я'.repeat(2000) }).success);
  assert.equal(OutcomeBody.safeParse({ ...base(), alsoDncPhoneIds: Array.from({ length: 11 }, (_, i) => `p${i}`) }).success, false);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]));
  assert.equal(OutcomeBody.safeParse({ ...base(), fields: many }).success, false);
  assert.equal(OutcomeBody.safeParse({ ...base(), lprInfo: { name: 'я'.repeat(201), phone: '', when: '' } }).success, false);
});

test('канал итога: ui или offline; запись только групповая', () => {
  assert.equal(OutcomeBody.safeParse({ ...base(), via: 'telephony' }).success, false);
  const agreement = (booking: unknown) => ({ ...base(), agreement: { contactId: 'ct-1', agreedDueAt: null, booking } });
  assert.ok(OutcomeBody.safeParse(agreement({ kind: 'group', eventId: 'ev-1' })).success);
  assert.equal(OutcomeBody.safeParse(agreement({ kind: 'individual', eventTypeKey: 'consult' })).success, false);
});

test('пропуск: opId и cardId обязательны, лишнего нет', () => {
  assert.ok(SkipBody.safeParse({ opId: OP, cardId: 'c' }).success);
  assert.equal(SkipBody.safeParse({ opId: OP }).success, false);
  assert.equal(SkipBody.safeParse({ opId: OP, cardId: 'c', x: 1 }).success, false);
});

test('очередь: limit 1–4 (по умолчанию 1), exclude ≤ 50, группа из списка', () => {
  assert.deepEqual(QueueQuery.parse({}), { limit: 1, exclude: [], group: 'all' });
  assert.equal(QueueQuery.parse({ limit: '4', exclude: 'a,b', group: 'retries' }).exclude.length, 2);
  assert.equal(QueueQuery.safeParse({ limit: '5' }).success, false);
  assert.equal(QueueQuery.safeParse({ limit: '0' }).success, false);
  assert.equal(QueueQuery.safeParse({ exclude: Array.from({ length: 51 }, (_, i) => `c${i}`).join(',') }).success, false);
  assert.equal(QueueQuery.safeParse({ group: 'все' }).success, false);
  assert.equal(QueueQuery.safeParse({ zzz: '1' }).success, false);
});
