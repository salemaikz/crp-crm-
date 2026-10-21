// Логотип безопасен по построению (D-333): нет путей, ведущих активное содержимое SVG в документ приложения.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
/** Исходник без комментариев: в них упоминать запрещённое можно. */
const read = (p: string) => readFileSync(path.join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('next.config.ts не разрешает SVG в next/image', () => {
  assert.ok(!/dangerouslyAllowSVG/.test(read('next.config.ts')));
});

test('BrandMark: без next/image и dangerouslySetInnerHTML', () => {
  const src = read('src/ui/shells/BrandMark.tsx');
  assert.ok(!/next\/image/.test(src));
  assert.ok(!/dangerouslySetInnerHTML/.test(src));
});

test('маршрут логотипа не читает params и параметры запроса сам', () => {
  const src = read('src/app/api/brand/logo/route.ts');
  assert.ok(!/params/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'params не используются');
  assert.ok(!/searchParams/.test(src));
});

test('логика ответа: имя файла не берётся из запроса', () => {
  const src = read('src/server/platform/brand/response.ts');
  const reads = [...src.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ['v']);
});
