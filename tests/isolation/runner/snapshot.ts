// Снимок таблиц: полное содержимое в стабильном порядке. Имя таблицы проверяется по каталогу схемы,
// запрос собирает Postgres (format %I) — без склейки SQL в тесте.
import type { Sql } from '../../../src/server/platform/db';
import type { Snapshot } from './checks';

export async function snapshotTables(sql: Sql, tables: readonly string[]): Promise<Snapshot> {
  const known = new Set((await sql<{ name: string }>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`).map((r) => r.name));
  const out: Record<string, string> = {};
  for (const t of tables) {
    if (!known.has(t)) throw new Error(`снимок: таблицы ${t} нет в схеме (опечатка в touches манифеста?)`);
    const [row] = await sql<{ xml: string }>`SELECT query_to_xml(format('SELECT to_jsonb(x) AS r FROM %I x ORDER BY 1', ${t}::text), false, false, '')::text AS xml`;
    out[t] = row?.xml ?? '';
  }
  return out;
}
