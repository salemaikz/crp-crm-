// Консультанты для e2e (B5b/B5c): сотрудник с ролью consultant и ресурс (направление «Маркетинг», общие часы).
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PASSWORD, sql } from './calling';

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');

export interface Consultant {
  userId: string;
  phone: string;
  resourceId: string;
  name: string;
}

/** Консультант с ролью `consultant`. `exclusive` — остальных консультантов пространства выключаем (подбор предсказуем). */
export async function makeConsultant(opts: { exclusive?: boolean } = {}): Promise<Consultant> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales');
  const t = Date.now();
  const c: Consultant = { userId: randomUUID(), phone: `7709${digits(7)}`, resourceId: randomUUID(), name: 'Консультант Синтетик' };
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${c.userId}, ${c.phone}, ${c.name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${c.userId}, ${space.id}, 'consultant', FALSE, ${t}, ${t})`;
  if (opts.exclusive) await sql`UPDATE resources SET active = FALSE, updated_at = ${t} WHERE space_id = ${space.id}`;
  await sql`
    INSERT INTO resources (id, space_id, user_id, directions, slot_min, capacity, auto_assign, active, sort, created_at, updated_at)
    VALUES (${c.resourceId}, ${space.id}, ${c.userId}, ARRAY['marketing']::text[], 45, 1, TRUE, TRUE, 0, ${t}, ${t})`;
  return c;
}

/** Хотя бы один активный консультант (без него подбор не предлагает ни времени, ни «Назначим утром»). */
export async function ensureConsultant(): Promise<void> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM resources WHERE active`;
  if (!row || row.n === 0) await makeConsultant();
}

export const pretty = (p: string): string => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
