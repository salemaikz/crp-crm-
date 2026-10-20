// Паритет сообщений: у каждой включённой локали (кроме ru) тот же набор файлов, те же ключи и те же
// ICU-аргументы, что у ru. Пока включён только ru — тест проверяет сам ru и механизм (kk добавится в LOCALES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOCALE, LOCALES, NAMESPACES } from '../../src/i18n/config';

const ROOT = join(import.meta.dirname, '..', '..', 'messages');

type Tree = { [key: string]: Tree | string };

export function flatten(tree: Tree, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') flatten(value, path, out);
    else out.set(path, String(value));
  }
  return out;
}

/** Имена ICU-аргументов верхнего уровня и rich-тегов: {name}, {count, plural, …}, <mark>. */
export function icuArgs(message: string): string[] {
  const args = new Set<string>();
  for (const m of message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)) if (m[1]) args.add(m[1]);
  for (const m of message.matchAll(/<([A-Za-z][\w-]*)>/g)) if (m[1]) args.add(`<${m[1]}>`);
  return [...args].sort();
}

const load = (locale: string, file: string): Tree => JSON.parse(readFileSync(join(ROOT, locale, file), 'utf8')) as Tree;
const files = (locale: string) =>
  existsSync(join(ROOT, locale)) ? readdirSync(join(ROOT, locale)).filter((f) => f.endsWith('.json')).sort() : [];

test('ru: файлы совпадают с NAMESPACES', () => {
  assert.deepEqual(files(DEFAULT_LOCALE), NAMESPACES.map((n) => `${n}.json`).sort());
});

test('на диске нет каталогов локалей, которых нет в LOCALES', () => {
  const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(dirs.filter((d) => !(LOCALES as readonly string[]).includes(d)), []);
});

test('ru: нет пустых строк', () => {
  for (const file of files(DEFAULT_LOCALE)) {
    for (const [key, value] of flatten(load(DEFAULT_LOCALE, file))) {
      assert.ok(value.trim() !== '', `ru/${file}: пустое значение ${key}`);
    }
  }
});

for (const locale of LOCALES.filter((l) => l !== DEFAULT_LOCALE)) {
  test(`${locale}: набор файлов как у ${DEFAULT_LOCALE}`, () => {
    assert.deepEqual(files(locale), files(DEFAULT_LOCALE));
  });
  for (const file of files(DEFAULT_LOCALE)) {
    test(`${locale}/${file}: ключи и ICU-аргументы как у ${DEFAULT_LOCALE}`, () => {
      const base = flatten(load(DEFAULT_LOCALE, file));
      const other = flatten(load(locale, file));
      const missing = [...base.keys()].filter((k) => !other.has(k));
      const extra = [...other.keys()].filter((k) => !base.has(k));
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
      for (const [key, value] of base) {
        const v = other.get(key) ?? '';
        assert.ok(v.trim() !== '', `${locale}/${file}: пусто ${key}`);
        assert.deepEqual(icuArgs(v), icuArgs(value), `${locale}/${file}: аргументы ${key}`);
      }
    });
  }
}

test('самопроверка icuArgs', () => {
  assert.deepEqual(icuArgs('Привет, {name}! {count, plural, one {# шт} other {# шт}} <b>x</b>'), ['<b>', 'count', 'name']);
});
