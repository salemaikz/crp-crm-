// Тесты машины состояний: исполняемая спецификация (spec/vectors.ts) и свойства.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VECTORS } from './spec/vectors.js';
import { applyOutcome } from './applyOutcome.js';

for (const v of VECTORS) {
  test(`${v.id} · ${v.title} (${v.refs.join(', ')})`, () => {
    const before = structuredClone({ card: v.input.card, event: v.input.event });
    assert.deepStrictEqual(applyOutcome(v.input), v.expected);
    // Вход не мутируется.
    assert.deepStrictEqual({ card: v.input.card, event: v.input.event }, before);
  });
}

test('id векторов уникальны', () => {
  assert.equal(new Set(VECTORS.map((v) => v.id)).size, VECTORS.length);
});

const WORKING = ['new', 'retry', 'callback'];

test('свойство: итог из рабочего состояния поднимает version ровно на 1', () => {
  for (const v of VECTORS) {
    const { card, event } = v.input;
    if (event.type !== 'outcome' || card === null || !WORKING.includes(card.state)) continue;
    const r = applyOutcome(v.input);
    if (r.status === 'applied' || r.status === 'fact_only') assert.equal(r.card.version, card.version + 1, v.id);
  }
});

test('свойство: nextCallAt задан только в retry и callback, returnAt — только в not_interested', () => {
  for (const v of VECTORS) {
    const r = applyOutcome(v.input);
    if (r.status !== 'applied' && r.status !== 'fact_only') continue;
    if (r.card.nextCallAt !== null) assert.ok(['retry', 'callback'].includes(r.card.state), `${v.id}: nextCallAt в ${r.card.state}`);
    if (r.card.returnAt !== null) assert.equal(r.card.state, 'not_interested', `${v.id}: returnAt`);
  }
});

test('свойство: в Effects всегда все массивы', () => {
  const keys = ['tasks', 'deals', 'bookings', 'stopList', 'assignLog', 'notifications', 'timeline', 'audit', 'skips'];
  for (const v of VECTORS) {
    const r = applyOutcome(v.input);
    if (r.status === 'applied' || r.status === 'fact_only') {
      for (const k of keys) assert.ok(Array.isArray((r.effects as unknown as Record<string, unknown>)[k]), `${v.id}: ${k}`);
    }
  }
});

test('пропуск не меняет карточку и не требует владельца для системы', () => {
  const v = VECTORS.find((x) => x.id === 'r25a');
  assert.ok(v);
  const r = applyOutcome({ ...v.input, actor: { userId: 'u-lead', kind: 'user', scope: 'space' } });
  assert.equal(r.status, 'applied');
});

test('системное событие от пользователя запрещено', () => {
  const v = VECTORS.find((x) => x.id === 'r29a');
  assert.ok(v);
  const r = applyOutcome({ ...v.input, actor: { userId: 'u-lead', kind: 'user', scope: 'space' } });
  assert.deepStrictEqual(r, { status: 'rejected', error: 'forbidden', field: null });
});

test('ручное событие без карточки — not_found', () => {
  const v = VECTORS.find((x) => x.id === 'r03a');
  assert.ok(v);
  assert.deepStrictEqual(applyOutcome({ ...v.input, card: null }), { status: 'rejected', error: 'not_found', field: null });
});
