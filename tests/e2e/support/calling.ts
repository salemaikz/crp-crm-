// Общее для сценариев «Звонить»: подготовка БД, оператор с карточками, вход, выборки итогов.
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у запущенного сервера).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, type BrowserContext, type Page } from '@playwright/test';

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
  clientIds: string[];
}

export interface OperatorOptions {
  /** У каждого клиента есть контакт-ЛПР («Асель Синтетик, Директор») со своим номером и заметка. */
  lpr?: boolean;
}

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');

/** Оператор отдела продаж и `cards` новых карточек в его очереди (порядок — по номеру). */
export async function makeOperator(cards: number, opts: OperatorOptions = {}): Promise<Operator> {
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
  const clientIds: string[] = [];
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
    if (opts.lpr) {
      const contactId = randomUUID();
      await sql`INSERT INTO contacts (id, client_id, name, position, is_decision_maker, created_at)
                VALUES (${contactId}, ${clientId}, 'Асель Синтетик', 'Директор', TRUE, ${t})`;
      await sql`INSERT INTO client_phones (id, client_id, contact_id, digits, kind, is_primary, created_at)
                VALUES (${randomUUID()}, ${clientId}, ${contactId}, ${`7709${digits(7)}`}, 'mobile', FALSE, ${t})`;
      await sql`INSERT INTO notes (id, client_id, space_id, body, created_at)
                VALUES (${randomUUID()}, ${clientId}, ${space.id}, 'Просили перезвонить после обеда', ${t})`;
    }
    clientIds.push(clientId);
    cardIds.push(cardId);
    names.push(name);
  }
  return { id, phone, cardIds, names, clientIds };
}

const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;

export async function login(page: Page, op: Operator): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(op.phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

/**
 * Вход одним запросом, без открытия страниц: cookie контекста меняется, а метку владельца телефона (D-292) ни одна
 * страница не ставит. Так проверяется защита на сервере (409 `wrong_user`) отдельно от метки.
 */
export async function loginByRequest(context: BrowserContext, op: Operator, origin: string): Promise<void> {
  const res = await context.request.post('/api/auth/login', { headers: { origin }, data: { phone: pretty(op.phone), password: PASSWORD } });
  expect(res.status()).toBe(200);
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

const DAY = 86_400_000;
const localDate = (plusDays: number) => new Date(Date.now() + plusDays * DAY + 5 * 3_600_000).toISOString().slice(0, 10);

/** Групповые мероприятия «БР» в пространстве: прежние запланированные снимаем, чтобы предложение было предсказуемым. */
export async function seedGroupEvents(specs: Array<{ id: string; plusDays: number; capacity?: number }>): Promise<void> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  await sql`UPDATE events SET status = 'cancelled', occurrence_key = NULL, updated_at = ${Date.now()} WHERE space_id = ${space!.id} AND status = 'scheduled'`;
  for (const e of specs) {
    const date = localDate(e.plusDays);
    const startsAt = Date.parse(`${date}T15:00:00+05:00`);
    await sql`
      INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, occurrence_key, touched, created_at, updated_at)
      VALUES (${e.id}, ${space!.id}, NULL, 'br', ${date}, '15:00', ${startsAt}, 180, 'Зал 1', 'offline', ${e.capacity ?? 30}, 'scheduled', NULL, FALSE, ${Date.now()}, ${Date.now()})`;
  }
}

/** Заполнить в шторке то, что требует «Договорились»: ЛПР «Да» и ниша (поле итога). */
export async function fillAgreed(page: Page): Promise<void> {
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-agreed').click();
  await page.getByTestId('outcome-details').getByRole('combobox').selectOption({ index: 1 });
}
