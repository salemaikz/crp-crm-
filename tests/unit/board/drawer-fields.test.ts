// Поля в шторке лида: правка на месте только при праве, типе и флаге (pipeline-v2 §9.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_ROWS, drawerRows, splitRows } from '@/ui/board/drawerFields';

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

test('поля плитки идут первыми, затем поля карточки; архивные и скрытые везде пропускаются, ничего не отрезается', () => {
  const many = Array.from({ length: 9 }, (_, i) => field(`f${i}`));
  const kanbanOnly = field('onTile', { showOn: { card: false, kanban: true, list: false } });
  const nowhere = field('nowhere', { showOn: { card: false, kanban: false, list: true } });
  const rows = drawerRows(dto([nowhere, field('old', { archived: true }), ...many, kanbanOnly], [field('cardfield')]), true);
  assert.equal(rows[0]?.field.key, 'onTile', 'поле плитки первым, хотя заведено последним');
  assert.equal(rows[1]?.field.object, 'card', 'дальше поля карточки раньше полей клиента');
  assert.equal(rows.length, 11, 'все поля на месте: 9 клиента + карточка + плитка');
  assert.ok(!rows.some((r) => r.field.key === 'nowhere' || r.field.key === 'old'));
});

test('«Ещё N полей»: шесть сразу и остаток; вместе они дают все поля в прежнем порядке', () => {
  const many = Array.from({ length: 9 }, (_, i) => field(`f${i}`));
  const rows = drawerRows(dto(many, []), true);
  const { first, rest } = splitRows(rows);
  assert.equal(first.length, FIRST_ROWS);
  assert.equal(rest.length, 3);
  assert.deepEqual([...first, ...rest].map((r) => r.field.key), rows.map((r) => r.field.key));
  assert.deepEqual(splitRows(rows.slice(0, 4)), { first: rows.slice(0, 4), rest: [] });
});

test('варианты списка: подписи по ключу, архивные не предлагаются', () => {
  const sel = field('kind', { type: 'select', value: 'a', options: [{ key: 'a', label: { ru: 'Альфа' }, archived: false }, { key: 'b', label: { ru: 'Бета' }, archived: true }] });
  const [row] = drawerRows(dto([sel], []), true);
  assert.deepEqual(row?.field.choices, [{ key: 'a', label: 'Альфа' }]);
  assert.equal(row?.field.options.a, 'Альфа');
});
