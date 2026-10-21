// Локали линии записи и сделок нейтральны к клиенту (AGENTS «Код и данные»): нет подписи роли клиента, номера в
// примерах — только синтетика +7 709 …, числа из настроек (шаг автоназначения) приходят подстановкой.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MODULES = ['booking', 'deals', 'handoffs'] as const;

/** Все строки JSON-локали с путём ключа. */
function strings(ns: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') out.push([path, v]);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', `${ns}.json`), 'utf8')), ns);
  return out;
}
const all = MODULES.flatMap(strings);

test('нет подписи роли клиента «РОП»: в локалях нейтральное «руководитель»', () => {
  assert.deepEqual(all.filter(([, s]) => /(^|[^\p{L}])роп([^\p{L}]|$)/iu.test(s)).map(([k]) => k), []);
});

test('номера в примерах — только синтетика +7 709 …', () => {
  const phones = all.flatMap(([k, s]) => [...s.matchAll(/(?:\+7|(?<![\d+])8)[\s-]?\(?(\d{3})/g)].map((m) => [k, m[1]] as const));
  assert.deepEqual(phones.filter(([, code]) => code !== '709').map(([k]) => k), []);
});

test('шаг автоназначения — подстановкой из настроек, а не числом в тексте', () => {
  const [, text] = all.find(([k]) => k === 'booking.consult.greyNextRun')!;
  assert.match(text, /\{minutes/);
  assert.doesNotMatch(text.replace(/\{[^{}]*\{[^}]*\}[^{}]*\}|\{[^}]*\}/g, ''), /\d/);
});
