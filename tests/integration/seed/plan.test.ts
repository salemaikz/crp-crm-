// План сида без БД: детерминизм, состав состояний, номера +7 709 …
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, quotas, RATIOS } from '../../../scripts/seed';
import { Rng, uuidFor } from '../../../scripts/seed/rng';

test('доли состояний дают ровно N карточек при любом N', () => {
  assert.equal(RATIOS.reduce((a, [, r]) => a + r, 0).toFixed(6), '1.000000');
  for (const n of [20, 37, 500, 1234]) {
    const total = [...quotas(n).values()].reduce((a, b) => a + b, 0);
    assert.equal(total, n);
  }
  const q = quotas(500);
  assert.equal(q.get('new_owned'), 140);
  assert.equal(q.get('new_pool'), 60);
  assert.equal(q.get('retry'), 90);
  assert.equal(q.get('callback'), 70);
});

test('план детерминирован: то же зерно — тот же план, другое — другой', () => {
  const a = buildPlan({ seed: 's1', clients: 500, operators: 5 });
  const b = buildPlan({ seed: 's1', clients: 500, operators: 5 });
  const c = buildPlan({ seed: 's2', clients: 500, operators: 5 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((p) => p.name), c.map((p) => p.name));
});

test('500 клиентов: номера только +7 709, уникальны; названия уникальны; операторы распределены поровну', () => {
  const plan = buildPlan({ seed: 'check', clients: 500, operators: 5 });
  assert.equal(plan.length, 500);
  const digits = plan.flatMap((p) => p.phones.map((x) => x.digits));
  assert.ok(digits.every((d) => /^7709[2-9]\d{6}$/.test(d)), 'каждый номер 7709 + цифра 2–9 + 6 цифр');
  assert.equal(new Set(digits).size, digits.length);
  assert.equal(new Set(plan.map((p) => p.name)).size, 500);
  const perOwner = new Map<number, number>();
  for (const p of plan) if (p.owner !== null) perOwner.set(p.owner, (perOwner.get(p.owner) ?? 0) + 1);
  assert.equal(perOwner.size, 5);
  const counts = [...perOwner.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `разброс по операторам: ${counts.join(',')}`);
  // пул — только новые карточки без владельца
  assert.ok(plan.filter((p) => p.owner === null).every((p) => p.kind === 'new_pool'));
  // у каждого клиента ровно один основной номер и хотя бы один контакт
  assert.ok(plan.every((p) => p.phones.filter((x) => x.primary).length === 1 && p.contacts.length >= 1));
});

test('перезвоны: на сегодня, на завтра и позже; недозвоны: один и два', () => {
  const plan = buildPlan({ seed: 'check', clients: 500, operators: 5 });
  const cb = plan.filter((p) => p.kind === 'callback');
  assert.ok(cb.some((p) => p.nextCall?.dayOffset === 0));
  assert.ok(cb.some((p) => p.nextCall?.dayOffset === 1));
  assert.ok(cb.some((p) => (p.nextCall?.dayOffset ?? 0) >= 2));
  const retry = plan.filter((p) => p.kind === 'retry');
  assert.ok(retry.some((p) => p.calls.length === 1) && retry.some((p) => p.calls.length === 2));
});

test('Rng и uuidFor: повторяемы и различаются по ключу', () => {
  const x = new Rng('z');
  const y = new Rng('z');
  assert.deepEqual([x.next(), x.int(1, 9)], [y.next(), y.int(1, 9)]);
  assert.equal(uuidFor('s', 'client', 1), uuidFor('s', 'client', 1));
  assert.notEqual(uuidFor('s', 'client', 1), uuidFor('s', 'client', 2));
  assert.match(uuidFor('s', 'client', 1), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
