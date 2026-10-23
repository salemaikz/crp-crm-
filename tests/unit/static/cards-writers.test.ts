// Все писатели `cards` перечислены (pipeline-v2 §5.4): новый UPDATE/INSERT без записи в списке роняет тест, а
// state-change обязан сбрасывать цикл перезвона (callback_reason и callback_touches) в том же выражении.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CARDS_WRITERS } from './cards-writers.allow';

const ROOT = 'src/server';
const WRITE = /\b(UPDATE cards\b|INSERT INTO cards\b)/;
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*(?::[^=]+)?=)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

interface Found { key: string; statement: string }

export function findWriters(files: readonly string[], read: (f: string) => string): Found[] {
  const out: Found[] = [];
  for (const file of files) {
    const lines = read(file).split('\n');
    let fn = '';
    lines.forEach((line, i) => {
      const d = DECL.exec(line);
      if (d) { fn = d[1] ?? d[2] ?? ''; }
      if (line.trimStart().startsWith('//') || !WRITE.test(line)) return;
      // Выражение — до закрывающей обратной кавычки шаблона
      const from = line.search(WRITE) + 1;
      let stop = i;
      while (stop < lines.length - 1 && !(stop === i ? lines[stop]!.slice(from) : lines[stop]!).includes('`')) stop++;
      out.push({ key: `${file.replaceAll('\\', '/')}::${fn}`, statement: lines.slice(i, stop + 1).join('\n') });
    });
  }
  return out;
}

const real = findWriters(walk(ROOT), (f) => readFileSync(f, 'utf8'));

test('каждый писатель cards есть в списке с категорией', () => {
  const missing = real.filter((w) => !(w.key in CARDS_WRITERS)).map((w) => w.key);
  assert.deepEqual(missing, [], 'новый путь записи cards: добавьте в tests/unit/static/cards-writers.allow.ts');
});

test('в списке нет записей без писателя', () => {
  const keys = new Set(real.map((w) => w.key));
  assert.deepEqual(Object.keys(CARDS_WRITERS).filter((k) => !keys.has(k)), []);
});

test('state-change пишет callback_reason и callback_touches в том же выражении', () => {
  const bad = real
    .filter((w) => CARDS_WRITERS[w.key]?.category === 'state-change')
    .filter((w) => !/callback_reason/.test(w.statement) || !/callback_touches/.test(w.statement))
    .map((w) => w.key);
  assert.deepEqual(bad, []);
});

test('детектор: новый UPDATE cards без записи и state-change без цикла ловятся', () => {
  const files = ['x/a.ts'];
  const src = [
    'export async function newWriter(tx) {',
    '  await tx`UPDATE cards SET state = ${s} WHERE id = ${id}`;',
    '}',
  ].join('\n');
  const found = findWriters(files, () => src);
  assert.equal(found.length, 1);
  assert.ok(!(found[0]!.key in CARDS_WRITERS));
  assert.ok(!/callback_touches/.test(found[0]!.statement));
});
