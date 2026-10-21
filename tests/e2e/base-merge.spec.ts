// B9b на телефоне РОП: «Спорные пары» — «Разные — тому же оператору» и слияние с предпросмотром (за FEATURE_MERGE).
// Нужна БД e2e (E2E_DATABASE_URL). Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';
import { uniquePhone } from './support/phones';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

const phone = () => uniquePhone(sql);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Нижняя панель и липкие кнопки перекрывают край: нажимаем самим элементом. */
async function tap(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((el) => (el as HTMLElement).click());
}

async function makeRop(): Promise<Operator> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const p = await phone();
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${p}, 'РОП Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'rop', FALSE, ${t}, ${t})`;
  return { id, phone: p, cardIds: [], names: [], clientIds: [] };
}

/** Пара: клиент оператора А и клиент оператора Б с общим номером (номер А добавлен Б). */
async function makePair(): Promise<{ pairId: string; a: { client: string; name: string }; b: { client: string; name: string } }> {
  const alpha = await makeOperator(1);
  const beta = await makeOperator(1);
  const [pa] = await sql<{ digits: string }[]>`SELECT digits FROM client_phones WHERE client_id = ${alpha.clientIds[0]!}`;
  const t = Date.now();
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES (${randomUUID()}, ${beta.clientIds[0]!}, ${pa!.digits}, 'mobile', ${t})`;
  const sides = [
    { client: alpha.clientIds[0]!, name: alpha.names[0]! },
    { client: beta.clientIds[0]!, name: beta.names[0]! },
  ].sort((x, y) => (x.client < y.client ? -1 : 1));
  const pairId = randomUUID();
  await sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, created_at) VALUES (${pairId}, ${sides[0]!.client}, ${sides[1]!.client}, 'shared_phone', ${t})`;
  return { pairId, a: sides[0]!, b: sides[1]! };
}

test('«Разные — тому же оператору»: пара уходит из списка, решение записано', async ({ page }) => {
  const rop = await makeRop();
  const pair = await makePair();
  await login(page, rop);
  await page.goto('/pairs');
  await expect(page.getByRole('heading', { name: 'Спорные пары' })).toBeVisible();
  const card = page.getByRole('article').filter({ hasText: pair.a.name });
  await expect(card.getByText(pair.b.name)).toBeVisible();
  await expect(card.getByText('Общий').first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  await tap(card.getByRole('button', { name: 'Разные — тому же оператору' }));
  await expect(page.getByText('Записано: клиенты разные, выдаются одному оператору')).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: pair.a.name })).toHaveCount(0);
  const [row] = await sql<{ status: string }[]>`SELECT status FROM dup_pairs WHERE id = ${pair.pairId}`;
  expect(row?.status).toBe('distinct');
});

test('«Объединить…»: предпросмотр показывает, что переедет, после слияния остаётся один клиент', async ({ page }) => {
  const rop = await makeRop();
  const pair = await makePair();
  await login(page, rop);
  const probe = await page.request.get(`/api/distribution/pairs/${pair.pairId}/merge-preview?survivor=a`);
  test.skip(probe.status() === 404, 'FEATURE_MERGE выключен');

  await page.goto('/pairs');
  const card = page.getByRole('article').filter({ hasText: pair.a.name });
  await tap(card.getByRole('button', { name: 'Объединить…' }));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Что переедет к остающемуся клиенту' })).toBeVisible();
  await expect(dialog.getByText('Совпавшие номера удалятся: 1')).toBeVisible();
  await expect(dialog.getByRole('cell', { name: 'Карточки' })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await tap(dialog.getByRole('button', { name: 'Объединить', exact: true }));
  await expect(page.getByText('Клиенты объединены')).toBeVisible();

  const [loser] = await sql<{ merged: string | null }[]>`SELECT merged_into_id AS merged FROM clients WHERE id = ${pair.b.client}`;
  expect(loser?.merged).toBe(pair.a.client);
  const [p] = await sql<{ status: string }[]>`SELECT status FROM dup_pairs WHERE id = ${pair.pairId}`;
  expect(p?.status).toBe('merged');
  // страница слитого клиента ведёт к выжившему
  await page.goto(`/clients/${pair.b.client}`);
  await expect(page).toHaveURL(new RegExp(`/clients/${pair.a.client}$`));
});
