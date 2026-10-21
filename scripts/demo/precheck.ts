// Проверка базы демо ДО миграций: пустая или только синтетика (+7 709 …) — можно; иначе отказ, схема не трогается.
// Критерий тот же, что у сида (assertStandDb): номера клиентов и сотрудников вне блока 7709 — это не стенд.
// Запуск: DATABASE_URL=… tsx scripts/demo/precheck.ts (код 0 — можно, 1 — отказ).
import postgres from 'postgres';

const PREFIX = '7709';

/** Причина отказа или null, если базу можно использовать под демо. */
export async function demoDbProblem(url: string): Promise<string | null> {
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const t = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
    if ((t[0]?.n ?? 0) === 0) return null; // пустая база
    const reg = await sql<{ m: string | null; c: string | null; u: string | null }[]>`
      SELECT to_regclass('public.schema_migrations')::text AS m, to_regclass('public.client_phones')::text AS c, to_regclass('public.users')::text AS u`;
    const r = reg[0];
    if (!r?.m) return 'в базе уже есть чужие таблицы без учёта миграций CRM';
    const like = `${PREFIX}%`;
    if (r.c) {
      const x = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_phones WHERE digits NOT LIKE ${like}`;
      if ((x[0]?.n ?? 0) > 0) return 'в базе есть клиенты с номерами вне синтетического блока 7709';
    }
    if (r.u) {
      const x = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE phone_digits NOT LIKE ${like}`;
      if ((x[0]?.n ?? 0) > 0) return 'в базе есть сотрудники с номерами вне синтетического блока 7709';
    }
    return null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}
demoDbProblem(url).then(
  (p) => {
    if (p) {
      console.error(`Отказ: ${p}. Это не демо-база, миграции не запускались.`);
      process.exit(1);
    }
  },
  (e) => {
    console.error(`Не удалось проверить базу: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
