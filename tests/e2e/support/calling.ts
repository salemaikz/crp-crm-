// Общее для сценариев «Звонить»: подготовка БД, оператор с карточками, вход, выборки итогов.
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у запущенного сервера).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, type Page } from '@playwright/test';

export const DB_URL = process.env.E2E_DATABASE_URL;
export const PASSWORD = 'Надёжный-пароль-77';
export const sql = DB_URL ? postgres(DB_URL, { max: 3 }) : (null as never);

/** Миграции и настройки пресета (идемпотентно). */
export function prepareDb(): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/support/prepare-db.ts'], { stdio: 'inherit', env: { ...process.env } });
}

export interface Operator {
  id: string;
  phone: string;
  cardIds: string[];
  names: string[];
}

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');

/** Оператор отдела продаж и `cards` новых карточек в его очереди (порядок — по номеру). */
export async function makeOperator(cards: number): Promise<Operator> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales: prepareDb() не выполнен');
  const id = randomUUID();
  const phone = `7709${digits(7)}`;
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at)
            VALUES (${id}, ${phone}, ${'Оператор Синтетик'}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at)
            VALUES (${id}, ${space.id}, 'operator', FALSE, ${t}, ${t})`;
  const tag = digits(5);
  const cardIds: string[] = [];
  const names: string[] = [];
  for (let i = 1; i <= cards; i++) {
    const clientId = randomUUID();
    const cardId = randomUUID();
    const name = `ТОО Синтетика ${tag} №${i}`;
    await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
              VALUES (${clientId}, 'company', ${name}, ${name.toLowerCase()}, ${name.toLowerCase()}, 'import', ${t}, ${t})`;
    await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
              VALUES (${randomUUID()}, ${clientId}, ${`7709${digits(7)}`}, 'mobile', TRUE, ${t})`;
    await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
              VALUES (${cardId}, ${space.id}, ${clientId}, ${id}, 'new', ${t}, ${t + i}, ${t})`;
    cardIds.push(cardId);
    names.push(name);
  }
  return { id, phone, cardIds, names };
}

const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;

export async function login(page: Page, op: Operator): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(op.phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

export async function openCall(page: Page, op: Operator): Promise<void> {
  await login(page, op);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
}

export interface CallRow {
  id: string;
  cardId: string;
  outcome: string;
  applied: string;
  via: string;
}

export async function callsOf(userId: string): Promise<CallRow[]> {
  return sql<CallRow[]>`SELECT id, card_id AS "cardId", outcome_code AS outcome, applied, via FROM calls WHERE user_id = ${userId} ORDER BY received_at`;
}

/** Нажать «Позвонить», дождаться шторки и поставить итог одним нажатием. */
export async function callAndOutcome(page: Page, kind: string): Promise<void> {
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await page.getByTestId(`outcome-${kind}`).click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
}

export const cardTitle = (page: Page) => page.locator('#call-title');
