// Текст push (D-033, D-328): закрытый список видов, только числа, plural по-русски; строки и длинные числа
// (номер телефона) в текст не попадают.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import messages from '../../../messages/ru/push.json';
import { formatPushTemplate, numericParams, PUSH_KINDS, pushTextFor } from '../../../src/server/domain/notify/pushText';

const kinds = messages.kinds as Record<string, string>;
const argNames = (tpl: string) => [...tpl.matchAll(/\{\s*([a-z][A-Za-z0-9]*)/g)].map((m) => m[1]!);

test('у каждого вида push есть текст, лишних текстов нет', () => {
  assert.deepEqual(Object.keys(kinds).sort(), [...PUSH_KINDS].sort());
});

test('шаблоны: только числовые подстановки и plural, всё разбирается', () => {
  for (const [kind, tpl] of Object.entries(kinds)) {
    assert.doesNotMatch(tpl, /,\s*(select|selectordinal|number|date|time)\b/, kind);
    for (const n of [0, 1, 2, 5, 11, 21, 102]) {
      const args = Object.fromEntries(argNames(tpl).map((a) => [a, n]));
      const out = formatPushTemplate(tpl, args);
      assert.ok(out !== null, `${kind} ${n}`);
      assert.doesNotMatch(out!, /[{}#]/, kind);
    }
  }
});

test('plural по-русски', () => {
  const t = (callbacks: number, bookings: number) => pushTextFor('digest_operator', { callbacks, bookings }).body;
  assert.equal(t(1, 1), 'Сводка дня: 1 перезвон, 1 запись');
  assert.equal(t(3, 2), 'Сводка дня: 3 перезвона, 2 записи');
  assert.equal(t(5, 11), 'Сводка дня: 5 перезвонов, 11 записей');
  assert.equal(t(21, 22), 'Сводка дня: 21 перезвон, 22 записи');
});

test('строки и длинные числа из params в текст не попадают', () => {
  assert.deepEqual(numericParams({ count: 3, name: 'ТОО Синтетика Альфа 1', phone: 77090000001, nested: { a: 1 }, frac: 1.5 }), { count: 3 });
  const a = pushTextFor('client_transferred', { count: 'ТОО Синтетика Альфа 1' });
  assert.equal(a.body, messages.fallback, 'нет числа — запасной текст, а не строка');
  const b = pushTextFor('client_transferred', { count: 2, name: 'ТОО Синтетика Альфа 1', phone: 77090000001 });
  assert.equal(b.body, 'Вам передано клиентов: 2');
  assert.equal(b.title, messages.title);
});

test('вид вне списка — нейтральный текст', () => {
  assert.equal(pushTextFor('card_merged', {}).body, messages.fallback);
  assert.equal(pushTextFor('', null).body, messages.fallback);
});

test('форматтер не принимает чужой синтаксис', () => {
  assert.equal(formatPushTemplate('{name, select, a {x} other {y}}', { name: 1 }), null);
  assert.equal(formatPushTemplate('{count', { count: 1 }), null);
  assert.equal(formatPushTemplate('count}', { count: 1 }), null);
  assert.equal(formatPushTemplate('{n, plural, one {{x}} other {y}}', { n: 1, x: 2 }), null);
  assert.equal(formatPushTemplate('{n, plural, =0 {нет} one {# раз} other {# раза}}', { n: 0 }), 'нет');
});
