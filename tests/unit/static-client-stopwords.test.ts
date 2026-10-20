// Специфика клиента живёт только в пресете и настройках (AGENTS.md, PLAN §7.1): в src/, packages/,
// messages/, public/ и манифесте нет имени клиента, его терминов и города. Стоп-слова ищутся целыми
// словами; допускаются только в presets/clients/** и фикстурах (их этот тест не сканирует).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, walk } from '../helpers/sourceFiles';

const L = '[\\p{L}\\p{N}_]';
const word = (w: string, flags = 'u') => new RegExp(`(?<!${L})${w}(?!${L})`, flags);

/** Чувствительны к регистру: аббревиатуры. */
export const CLIENT_WORDS: Array<[string, RegExp]> = [
  ['ЦРП', word('ЦРП')],
  ['БР', word('БР')],
  ['БК', word('БК')],
  ['Астана', word('Астан[а-яё]*', 'iu')],
  ['Центр Развития Предпринимателей', /Центр\w*\s+Развития\s+Предпринимател/iu],
  ['crp', word('crp(?:[-_.]\\w+)?', 'iu')],
];

/** Источник лидов клиента в продукт не входит (AGENTS.md): слов «парсер» и «сборщик» нет. */
export const FORBIDDEN_SOURCE_WORDS: Array<[string, RegExp]> = [
  ['парсер', /парсер/iu],
  ['сборщик', /сборщик/iu],
];

const TEXT = ['.ts', '.tsx', '.mjs', '.css', '.json', '.md', '.webmanifest', '.svg', '.html'] as const;

export function scan(files: string[], words: Array<[string, RegExp]>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of words) if (re.test(line)) hits.push(`${f}:${i + 1} — «${name}»`);
    });
  }
  return hits;
}

const clientFree = () => ['src', 'packages', 'messages', 'public'].flatMap((d) => walk(d, TEXT));

test('в src/, packages/, messages/, public/ нет стоп-слов клиента', () => {
  assert.deepEqual(scan(clientFree(), CLIENT_WORDS), []);
});

test('в src/, packages/, messages/, presets/ нет слов «парсер» и «сборщик»', () => {
  const files = ['src', 'packages', 'messages', 'presets'].flatMap((d) => walk(d, TEXT));
  assert.deepEqual(scan(files, FORBIDDEN_SOURCE_WORDS), []);
});

test('самопроверка: стоп-слова находятся как целые слова', () => {
  const hit = (s: string) => CLIENT_WORDS.some(([, re]) => re.test(s));
  assert.ok(hit('Запись на БР в Астане'));
  assert.ok(hit('мероприятие БК'));
  assert.ok(hit('ЦРП'));
  assert.ok(hit('crp-kz'));
  assert.ok(!hit('БРАК и БКД'));
  assert.ok(!hit('{eventShort}'));
  assert.ok(!hit('crm'));
});
