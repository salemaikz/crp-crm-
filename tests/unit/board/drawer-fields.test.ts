// Поля в шторке лида: правка на месте только при праве, типе и флаге (pipeline-v2 §9.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerRows } from '@/ui/board/drawerFields';

type Dto = Parameters<typeof drawerRows>[0];
const field = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  type: 'text',
  label: { ru: key.toUpperCase() },
  access: 'edit',
  options: [],
  value: null,
  href: null,
  showOn: { card: true, kanban: false, list: false },
  archived: false,
  ...over,
});
const dto = (client: unknown[], cardFields: unknown[], can = { edit: true, editCard: true }): Dto =>
  ({ fields: { fields: client, values: {} }, card: { fields: { fields: cardFields, values: {} } }, can }) as unknown as Dto;

test('поле с правом правки и простым типом редактируется на месте; без флага — нет', () => {
  const d = dto([field('niche')], []);
  assert.equal(drawerRows(d, true)[0]?.field.editable, true);
  assert.equal(drawerRows(d, false).length, 0, 'пустое поле без права правки не показывается');
});

test('нет права на объект, доступ «только чтение» или тип datetime — кнопки правки нет, заполненное значение видно', () => {
  const d = dto([field('a', { value: 'x', access: 'read' }), field('b', { value: 'y', type: 'datetime' }), field('c', { value: 'z' })], [], { edit: false, editCard: true });
  const rows = drawerRows(d, true);
  assert.deepEqual(rows.map((r) => [r.field.key, r.field.editable]), [['a', false], ['b', false], ['c', false]]);
});

test('поля карточки идут раньше полей клиента, архивные и не для карточки пропускаются, строк не больше шести', () => {
  const many = Array.from({ length: 9 }, (_, i) => field(`f${i}`));
  const rows = drawerRows(dto([field('hidden', { showOn: { card: false, kanban: true, list: false } }), field('old', { archived: true }), ...many], [field('cardfield')]), true);
  assert.equal(rows.length, 6);
  assert.equal(rows[0]?.field.object, 'card');
  assert.ok(!rows.some((r) => r.field.key === 'hidden' || r.field.key === 'old'));
});

test('варианты списка: подписи по ключу, архивные не предлагаются', () => {
  const sel = field('kind', { type: 'select', value: 'a', options: [{ key: 'a', label: { ru: 'Альфа' }, archived: false }, { key: 'b', label: { ru: 'Бета' }, archived: true }] });
  const [row] = drawerRows(dto([sel], []), true);
  assert.deepEqual(row?.field.choices, [{ key: 'a', label: 'Альфа' }]);
  assert.equal(row?.field.options.a, 'Альфа');
});
