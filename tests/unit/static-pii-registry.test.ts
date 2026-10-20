// Реестр ПДн (D-053, ARCHITECTURE §4.6) сверяется с пометками «-- pii» в миграциях в обе стороны:
// колонка с пометкой без строки реестра не будет обезличена, строка реестра без пометки — опечатка
// или устаревшая запись. Таблицы, которых ещё нет (телефония, D-069), пропускаются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, walk } from '../helpers/sourceFiles';

/**
 * Имена из реестра, которых нет в миграциях: таблицы телефонии придут отдельной миграцией
 * (INTEGRATIONS §2.7, D-069); crm_recordings — том с файлами записей, а не таблица.
 */
const NOT_YET = new Set(['call_intents', 'telephony_calls', 'call_recordings', 'crm_recordings']);

type Pair = `${string}.${string}`;

/** Колонки с пометкой «-- pii» по всем миграциям: CREATE TABLE … ( колонка … -- pii … ). */
export function piiColumnsFromSql(sql: string): { pii: Set<Pair>; tables: Set<string> } {
  const pii = new Set<Pair>();
  const tables = new Set<string>();
  let table: string | null = null;
  for (const line of sql.split('\n')) {
    const start = /^\s*CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(line);
    if (start) {
      table = start[1]!.toLowerCase();
      tables.add(table);
      continue;
    }
    const alter = /^\s*ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\b.*--\s*pii\b/i.exec(line);
    if (alter) {
      pii.add(`${alter[1]!.toLowerCase()}.${alter[2]!.toLowerCase()}`);
      continue;
    }
    if (table && /^\s*\);/.test(line)) {
      table = null;
      continue;
    }
    if (!table) continue;
    const col = /^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/.exec(line);
    if (col && /--\s*pii\b/.test(line)) pii.add(`${table}.${col[1]}`);
  }
  return { pii, tables };
}

/** Пары «таблица.колонка» из таблицы §4.6: первые две колонки строк, имена в обратных кавычках. */
export function registryFromArchitecture(md: string): { pairs: Set<Pair>; tables: Set<string>; noPii: Set<string> } {
  const start = md.indexOf('### 4.6.');
  assert.ok(start >= 0, 'в ARCHITECTURE.md нет раздела 4.6');
  const end = md.indexOf('\n## ', start);
  const section = md.slice(start, end < 0 ? undefined : end);
  const pairs = new Set<Pair>();
  const tables = new Set<string>();
  const noPii = new Set<string>();
  const ticks = (s: string) => [...s.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]!);
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || cells[0] === 'Где') continue;
    const rowTables = ticks(cells[0]!);
    if (rowTables.length === 0) continue; // «копии БД»
    const cols = ticks(cells[1]!).filter((c) => c !== 'pii' && !rowTables.includes(c));
    for (const t of rowTables) {
      tables.add(t);
      if (cells[1] === '—') noPii.add(t);
      for (const c of cols) pairs.add(`${t}.${c}`);
    }
  }
  return { pairs, tables, noPii };
}

const migrations = walk('migrations', ['.sql']);
const sql = piiColumnsFromSql(migrations.map(read).join('\n'));
const registry = registryFromArchitecture(read('docs/ARCHITECTURE.md'));

test('разбор находит миграции, пометки и строки реестра', () => {
  assert.ok(migrations.length > 0, 'нет файлов migrations/*.sql');
  assert.ok(sql.pii.size >= 20, `пометок «-- pii» подозрительно мало: ${sql.pii.size}`);
  assert.ok(registry.pairs.size >= 20, `строк реестра подозрительно мало: ${registry.pairs.size}`);
  assert.ok(sql.pii.has('clients.name') && registry.pairs.has('clients.name'));
});

test('каждая колонка с пометкой «-- pii» есть в реестре ARCHITECTURE §4.6', () => {
  const missing = [...sql.pii].filter((p) => !registry.pairs.has(p)).sort();
  assert.deepEqual(missing, [], 'добавьте колонки в реестр §4.6 (и в piiRegistry.ts): обезличивание их не увидит');
});

test('каждая строка реестра — существующая колонка с пометкой «-- pii»', () => {
  const unknownTables = [...registry.tables].filter((t) => !sql.tables.has(t) && !NOT_YET.has(t)).sort();
  assert.deepEqual(unknownTables, [], 'таблицы реестра нет в миграциях');
  const unmarked = [...registry.pairs]
    .filter((p) => !NOT_YET.has(p.split('.')[0]!))
    .filter((p) => !sql.pii.has(p))
    .sort();
  assert.deepEqual(unmarked, [], 'колонка из реестра не помечена «-- pii» в миграции (или её нет)');
});

test('таблицы, где по реестру ПДн нет (audit_log), не содержат пометок «-- pii»', () => {
  assert.ok(registry.noPii.has('audit_log'));
  for (const t of registry.noPii) {
    const marked = [...sql.pii].filter((p) => p.startsWith(`${t}.`));
    assert.deepEqual(marked, [], `${t}: по реестру ПДн там нет`);
  }
});

test('самопроверка разбора: колонка, ALTER ADD COLUMN и комментарий вне таблицы', () => {
  const r = piiColumnsFromSql(
    [
      '-- Колонки с ПДн помечены «-- pii»',
      'CREATE TABLE IF NOT EXISTS t1 (',
      "  a TEXT NOT NULL DEFAULT '', -- pii: имя",
      '  b JSONB NOT NULL,            -- коды без pii',
      '  c TEXT,-- pii',
      ');',
      'ALTER TABLE t1 ADD COLUMN IF NOT EXISTS d TEXT; -- pii',
    ].join('\n'),
  );
  assert.deepEqual([...r.pii].sort(), ['t1.a', 't1.c', 't1.d']);
  const reg = registryFromArchitecture(
    ['### 4.6. Реестр', '| Где | Колонки | Что |', '|---|---|---|', '| `t1`, `t2` | `a`, `custom` (поля с `pii`) | пусто |', '| копии БД | все | — |', '', '## 5.'].join('\n'),
  );
  assert.deepEqual([...reg.pairs].sort(), ['t1.a', 't1.custom', 't2.a', 't2.custom']);
});
