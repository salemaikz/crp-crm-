// Одно правило просрочки перезвона (pipeline-v2 §4.3): выражения `next_call_at <` и `next_call_at <=` в src/server/**
// есть только в перечисленных функциях. Просрочка считается двумя слагаемыми с границами `dueBounds` ядра; остальные
// сравнения — «наступил ли срок» (очередь, лимит раздачи) и «до начала завтрашних суток», а не просрочка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/server';
/** файл → функции, где сравнение допустимо. */
const ALLOWED: Record<string, readonly string[]> = {
  'src/server/domain/notify/repo.ts': ['countCallbacksDue', 'overdueCallbackStats'],
  'src/server/domain/calls/repo.ts': ['selectQueue', 'countQueue'],
  'src/server/domain/reports/repo.ts': ['selectOverdueCallbacks'],
  // доска: «огонёк» = срок раньше начала завтрашних суток (§6.2), а не просрочка
  'src/server/domain/cards/boardRepo.ts': ['callbackKeys', 'agreedKeys', 'simpleKeys'],
  'src/server/domain/distribution/repo.ts': ['loadParticipantLoad'],
};
/** Функции, считающие именно просрочку: обязаны брать обе границы ядра. */
const OVERDUE_FUNCTIONS: Record<string, readonly string[]> = {
  'src/server/domain/notify/repo.ts': ['overdueCallbackStats'],
  'src/server/domain/calls/repo.ts': ['countQueue'],
  'src/server/domain/reports/repo.ts': ['selectOverdueCallbacks'],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const FN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const CMP = /next_call_at\s*(?:<=|<)\s/;

function functionBodies(src: string): Map<string, string> {
  const lines = src.split('\n');
  const out = new Map<string, string>();
  let name: string | null = null;
  for (const line of lines) {
    const m = FN.exec(line);
    if (m) {
      name = m[1]!;
      out.set(name, '');
    }
    if (name) out.set(name, `${out.get(name)}${line}\n`);
  }
  return out;
}

test('сравнения next_call_at < и <= — только в перечисленных функциях', () => {
  const bad: string[] = [];
  for (const file of walk(ROOT)) {
    const bodies = functionBodies(readFileSync(file, 'utf8'));
    const key = file.split('\\').join('/');
    for (const [fn, body] of bodies) {
      if (CMP.test(body) && !(ALLOWED[key] ?? []).includes(fn)) bad.push(`${key}: ${fn}`);
    }
    // сравнение вне функции (на уровне модуля) тоже нарушение
    const outside = readFileSync(file, 'utf8')
      .split('\n')
      .some((l, i, all) => CMP.test(l) && !all.slice(0, i + 1).some((x) => FN.test(x)));
    if (outside) bad.push(`${key}: вне функции`);
  }
  assert.deepEqual(bad, []);
});

test('функции просрочки пишут два слагаемых с границами ядра', () => {
  for (const [file, fns] of Object.entries(OVERDUE_FUNCTIONS)) {
    const bodies = functionBodies(readFileSync(file, 'utf8'));
    for (const fn of fns) {
      const body = bodies.get(fn);
      assert.ok(body, `${file}: нет функции ${fn}`);
      assert.match(body, /next_call_precision = 'time' AND [\w.]*next_call_at <= \$\{[\w.]*bounds\.timeBefore\}/, `${fn}: слагаемое «время»`);
      assert.match(body, /next_call_precision = 'day' AND [\w.]*next_call_at < \$\{[\w.]*bounds\.dayBefore\}/, `${fn}: слагаемое «день»`);
    }
  }
});

test('самопроверка: запрещённое выражение вне перечня находится', () => {
  const src = 'export async function other() {\n  return sql`SELECT 1 FROM cards c WHERE c.next_call_at < ${x}`;\n}\n';
  const bodies = functionBodies(src);
  assert.equal(CMP.test(bodies.get('other')!), true);
});
