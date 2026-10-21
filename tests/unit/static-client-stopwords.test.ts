// Специфика клиента живёт только в пресете и настройках (AGENTS.md, PLAN §7.1): в src/, packages/,
// messages/, public/ и манифесте нет имени клиента, его терминов и города. Стоп-слова ищутся целыми
// словами; допускаются только в presets/clients/** и фикстурах (их этот тест не сканирует).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, walk } from '../helpers/sourceFiles';

/** 'word' — целое слово (стык camelCase считается границей); 'any' — подстрока в любом месте и регистре. */
type Boundary = 'word' | 'any';
type Entry = [name: string, re: RegExp, boundary: Boundary];

const isLetter = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isLower = (c: string | undefined) => c !== undefined && /\p{Ll}/u.test(c);
const isUpper = (c: string | undefined) => c !== undefined && /\p{Lu}/u.test(c);

/** Поиск без учёта регистра; для 'word' слово ограничено не-буквами или стыком camelCase (crpTheme, presetCrp). */
export function matches(line: string, [, re, boundary]: Entry): boolean {
  const g = new RegExp(re.source, `g${re.flags.replace(/[gi]/g, '')}i`);
  for (const m of line.matchAll(g)) {
    if (boundary === 'any') return true;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prev = line[start - 1];
    const next = line[end];
    const startOk = !isLetter(prev) || (isLower(prev) && isUpper(m[0][0]));
    const endOk = !isLetter(next) || (isUpper(next) && isLower(m[0][m[0].length - 1]));
    if (startOk && endOk) return true;
  }
  return false;
}

/** Имя клиента, его термины и город — в любом регистре и написании. */
export const CLIENT_WORDS: Entry[] = [
  ['ЦРП', /црп/u, 'any'],
  ['БР', /бр/u, 'word'],
  ['БК', /бк/u, 'word'],
  ['Астана', /астан/u, 'any'],
  ['Astana', /astana/u, 'any'],
  ['Центр Развития Предпринимателей', /центр\w*\s+развития\s+предпринимател/u, 'any'],
  ['crp', /crp/u, 'any'],
];

/** Источник лидов клиента в продукт не входит (AGENTS.md): слов «парсер» и «сборщик» нет. */
export const FORBIDDEN_SOURCE_WORDS: Entry[] = [
  ['парсер', /парсер/u, 'any'],
  ['сборщик', /сборщик/u, 'any'],
];

const TEXT = ['.ts', '.tsx', '.mjs', '.css', '.json', '.md', '.webmanifest', '.svg', '.html'] as const;

export function scan(files: string[], words: Entry[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      for (const w of words) if (matches(line, w)) hits.push(`${f}:${i + 1} — «${w[0]}»`);
    });
  }
  return hits;
}

const clientFree = () => ['src', 'packages', 'messages', 'public'].flatMap((d) => walk(d, TEXT));

test('в src/, packages/, messages/, public/ нет стоп-слов клиента', () => {
  assert.deepEqual(scan(clientFree(), CLIENT_WORDS), []);
});

test('в messages/ нет подписи роли клиента «РОП» (нейтральное «руководитель»)', () => {
  const rop: Entry = ['РОП', /роп/u, 'word'];
  assert.deepEqual(scan(walk('messages', TEXT), [rop]), []);
});

test('в src/, packages/, messages/, presets/ нет слов «парсер» и «сборщик»', () => {
  const files = ['src', 'packages', 'messages', 'presets'].flatMap((d) => walk(d, TEXT));
  assert.deepEqual(scan(files, FORBIDDEN_SOURCE_WORDS), []);
});

test('самопроверка: стоп-слова находятся в любом регистре и в camelCase', () => {
  const hit = (s: string) => CLIENT_WORDS.some((w) => matches(s, w));
  for (const bad of [
    'Запись на БР в Астане', 'мероприятие БК', 'ЦРП', 'цРп', 'ЦРПшный', 'црп', 'crp-kz', 'CRP', 'const crpTheme = 1', 'presetCrp',
    'Astana', 'astana', 'ASTANA', 'город Астана', 'АСТАНА', 'Центр Развития Предпринимателей', 'бр', 'вид БК.',
  ]) {
    assert.ok(hit(bad), `должно найтись: ${bad}`);
  }
  for (const ok of ['БРАК и БКД', '{eventShort}', 'crm', 'abracadabra', 'обрезка', 'Бразилия']) {
    assert.ok(!hit(ok), `не должно найтись: ${ok}`);
  }
});
