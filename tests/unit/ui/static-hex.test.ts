// Цвета не живут в компонентах (D-342, pipeline-v2 §10): hex-цвета разрешены только в src/ui/theme/** и в
// трёх файлах с причиной. Всё остальное берёт цвет из переменных темы, иначе тёмная тема ломается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Исключения: файл → причина. */
const ALLOWED: Record<string, string> = {
  'src/ui/tokens.css': 'умолчания токенов; совпадение с computeTheme сверяет tokens.test.ts',
  'src/app/icon.tsx': 'иконка рисуется до CSS, запасные цвета на случай отсутствия настроек',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

test('hex-цвета только в src/ui/theme/** и в списке исключений', () => {
  const bad: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel.startsWith('src/ui/theme/') || rel in ALLOWED) continue;
    // шестнадцатеричный цвет, а не якорь или номер задачи: после # 3, 4, 6 или 8 hex-цифр и граница слова
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)) {
      const before = text.slice(Math.max(0, m.index - 1), m.index);
      if (/[\w&]/.test(before)) continue; // &#x…; или часть слова
      bad.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('белое в компонентах: нет text-white/bg-white, фиксированных цветов Tailwind, rgb(255…) в kit.css', () => {
  const bad: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel.startsWith('src/ui/theme/')) continue;
    const text = readFileSync(file, 'utf8');
    if (/\b(?:text|bg|border)-(?:white|black)\b|\b(?:text|bg|border|ring)-(?:neutral|gray|slate|zinc|stone|red|green|amber|blue|yellow)-\d{2,3}\b/.test(text)) bad.push(`${rel}: утилита white/black`);
    if (rel.endsWith('.css') && /rgba?\(\s*255\s+255\s+255|rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(text)) bad.push(`${rel}: белый rgb`);
  }
  assert.deepEqual(bad, []);
});

test('исключения действительно нужны: файлы существуют и содержат hex', () => {
  for (const rel of Object.keys(ALLOWED)) assert.match(readFileSync(join(ROOT, rel), 'utf8'), /#[0-9a-f]{6}\b/i, rel);
});
