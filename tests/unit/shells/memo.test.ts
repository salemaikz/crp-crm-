// Памятки оператора (S5): раздел «Доска» есть в нейтральной памятке и в памятке клиента, названия колонок памятки клиента
// совпадают с пресетом, нейтральная памятка не содержит терминов клиента, объём — в пределах одного листа A4 (8 pt, две колонки).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const neutral = read('docs/operator-memo.md');
const client = read('presets/clients/crp/operator-memo.md');

test('нейтральная памятка: раздел «Доска», поиск над доской в §5, подстановка {колонки}', () => {
  assert.match(neutral, /^## 3а\. Доска \(включается флагом `OP_BOARD`/m);
  assert.match(neutral, /\{колонки\}/);
  assert.match(neutral, /^## 5\. Клиенты и задачи\n- \*\*Поиск\*\*/m);
  for (const word of ['Огонёк', 'По горячести', 'Перенести в…', 'Мусор', 'Явку', 'Мои покупки']) assert.ok(neutral.includes(word), word);
});

test('нейтральная памятка не называет клиента и его мероприятия (кроме пути к примеру)', () => {
  const text = neutral.replace(/presets\/clients\/crp\/operator-memo\.md/g, '');
  assert.ok(!/ЦРП|Бизнес-разбор|Бизнес-консультация|Целина|Астана/i.test(text));
});

test('памятка клиента: колонки доски — те же, что в пресете, по порядку', () => {
  const preset = JSON.parse(read('presets/clients/crp/preset.json')) as { spaces: { sales: { board: { columns: { label: { ru: string } }[] } } } };
  const labels = preset.spaces.sales.board.columns.map((c) => c.label.ru);
  const section = client.slice(client.indexOf('## Доска'));
  assert.ok(section.length > 100, 'раздел «Доска» есть');
  let at = -1;
  for (const l of labels) {
    const i = section.indexOf(l, at + 1);
    assert.ok(i > at, `колонка «${l}» в порядке пресета`);
    at = i;
  }
});

test('объём нейтральной памятки: не больше 1130 слов (иначе не уместится на один лист A4 при 8 pt)', () => {
  const words = neutral.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 1130, `слов: ${words}`);
});

test('нейтральная памятка: очередь «в том же порядке» — через «Звонить» в меню, кнопка «Звонить подряд» только на ноутбуке', () => {
  assert.match(neutral, /«Звонить» в меню \(на\s+ноутбуке — «Звонить подряд»\)/);
});
