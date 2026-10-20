// Фикстуры интеграционных тестов входа: синтетические сотрудники, без реальных номеров.
import { newId, type Sql } from '../../../src/server/platform/db';
import { hashPassword } from '../../../src/server/platform/auth/password';

export const T0 = 1_760_000_000_000;
export const DAY = 86_400_000;

export async function createUser(
  sql: Sql,
  o: { phone?: string; password?: string | null; status?: 'active' | 'disabled'; name?: string; isAdmin?: boolean } = {},
): Promise<{ id: string; phone: string }> {
  const id = newId();
  const phone = o.phone ?? `7701555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const hash = o.password === null ? null : await hashPassword(o.password ?? 'Надёжный-пароль-77');
  await sql`
    INSERT INTO users (id, phone_digits, name, password_hash, status, is_admin, created_at)
    VALUES (${id}, ${phone}, ${o.name ?? 'Тест Тестов'}, ${hash}, ${o.status ?? 'active'}, ${o.isAdmin ?? false}, ${T0})`;
  return { id, phone };
}

export async function createSpace(sql: Sql, key = 'sales'): Promise<string> {
  const id = newId();
  await sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES (${id}, ${key}, FALSE, ${T0})`;
  return id;
}

