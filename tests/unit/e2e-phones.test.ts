// Номера в e2e (AGENTS.md «Только синтетика»): только +7 709 … и без коллизий в прогоне. Случайный номер из 4 цифр в
// общей БД e2e совпадал с номером прошлой попытки (users_phone_uq) и ронял beforeAll. Номер сотрудника или клиента
// берётся из tests/e2e/support/phones.ts (счётчик прогона со сверкой с БД), а не собирается на месте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk } from '../helpers/sourceFiles';

const files = walk('tests/e2e', ['.ts']);

/** Код оператора в начале строкового литерала ('8701…', `7701…`, "+7 701…") или в записи «8 701» / «+7 701». */
const LITERAL_START = /['"`](?:\+7|8|7)[ (]?(7\d\d)/g;
const SPACED = /(?:\+7|(?<!\d)8)[ (](7\d\d)(?=[ )\d…])/g;

test('e2e: номера только из диапазона +7 709', () => {
  assert.ok(files.length > 0);
  const bad: string[] = [];
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const re of [LITERAL_START, SPACED]) {
        for (const m of line.matchAll(re)) if (m[1] !== '709') bad.push(`${f}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('e2e: номер не собирается на месте из случайных цифр — только uniquePhone() из support/phones.ts', () => {
  const bad: string[] = [];
  for (const f of files) {
    if (f === 'tests/e2e/support/phones.ts') continue;
    const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/`(?:\+?7|8)\s?709\$\{/.test(line) || /`77\d\d\d*\$\{/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
