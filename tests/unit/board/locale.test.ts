// Тексты доски: каждый ключ, который запрашивает код, есть в messages/ru/board.json; лишних ключей нет;
// в локали нет терминов клиента (общий тест стоп-слов это тоже ловит, здесь — на уровне модуля).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, walk } from '../../helpers/sourceFiles';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const messages = JSON.parse(readFileSync(join(ROOT, 'messages/ru/board.json'), 'utf8')) as Record<string, unknown>;

function leaves(o: unknown, prefix = ''): string[] {
  if (typeof o === 'string') return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}
const all = new Set(leaves(messages));

const files = walk('src/ui/board', ['.ts', '.tsx']);
const source = files.map((f) => read(f)).join('\n');

test('все статические ключи t(\'…\') из src/ui/board есть в локали', () => {
  const used = [...source.matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]!);
  assert.ok(used.length > 40, 'ключи найдены');
  assert.deepEqual(used.filter((k) => !all.has(k)), []);
});

test('динамические ключи (состояния, сортировки, фильтры, значки, причины блокировки) перечислены в локали', () => {
  const expected = [
    ...['new', 'retry', 'callback', 'agreed', 'client', 'not_interested', 'not_target', 'do_not_call', 'written_off'].map((s) => `state.${s}`),
    ...['heat', 'due', 'new'].map((s) => `sort.${s}`),
    ...['today', 'attendedGroup', 'attendedIndividual', 'noShow', 'purchased'].map((s) => `filters.${s}`),
    ...['attendedGroup', 'attendedIndividual', 'purchased', 'noShow'].map((s) => `badge.${s}`),
    ...['same', 'later', 'viewer', 'manual', 'offline'].map((s) => `move.blocked.${s}`),
    ...['noRight', 'noBooking', 'notStarted', 'done', 'lastStatus'].map((s) => `toggle.hint.${s}`),
    ...['attended', 'no_show', 'unmarked'].map((s) => `exit.status.${s}`),
    ...['noRight', 'notStarted'].map((s) => `exit.hint.${s}`),
    ...['min', 'hour', 'day'].map((s) => `due.ago.${s}`),
    ...['new', 'callback', 'agreed', 'client', 'trash'].map((s) => `column.emptyByRole.${s}`),
    ...['not_target', 'do_not_call', 'written_off'].map((s) => `trash.group.effect.${s}`),
    ...['confirmed', 'registered', 'no_show'].map((s) => `chip.status.${s}`),
  ];
  assert.deepEqual(expected.filter((k) => !all.has(k)), []);
});

test('в локали нет ключей, которых не использует код (мёртвые тексты)', () => {
  const dynamicPrefixes = ['state.', 'sort.', 'filters.', 'badge.', 'move.blocked.', 'due.ago.', 'toggle.hint.', 'exit.status.', 'exit.hint.', 'column.emptyByRole.', 'trash.group.effect.', 'chip.status.', ...['changed', 'tooLate', 'notApplicable', 'unavailable', 'readOnly', 'failed'].map((s) => `confirm.toast.${s}`)];
  const dead = [...all].filter((k) => !dynamicPrefixes.some((p) => k.startsWith(p)) && !source.includes(`'${k}'`));
  assert.deepEqual(dead, []);
});

test('ключи пространства имён board объявлены в NAMESPACES', () => {
  assert.match(readFileSync(join(ROOT, 'src/i18n/config.ts'), 'utf8'), /'board'/);
});
