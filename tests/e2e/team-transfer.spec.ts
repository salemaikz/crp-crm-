// B9a на телефоне РОП: «Передать…» из карточки клиента, массовая передача (за FEATURE_BULK_TRANSFER) и отключение
// сотрудника с передачей дел. Нужна БД e2e (E2E_DATABASE_URL). Синтетика: номера +7 709 …, «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

const phone = () => `7709${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Нижняя панель и липкие кнопки перекрывают край: нажимаем самим элементом. */
async function tap(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((el) => (el as HTMLElement).click());
}

async function makeStaff(name: string, roleKey: 'rop' | null, isAdmin = false): Promise<Operator> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const p = phone();
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, is_admin, password_hash, created_at) VALUES (${id}, ${p}, ${name}, ${isAdmin}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  if (roleKey) {
    await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, ${roleKey}, FALSE, ${t}, ${t})`;
  }
  return { id, phone: p, cardIds: [], names: [], clientIds: [] };
}

const rename = (op: Operator, name: string) => sql`UPDATE users SET name = ${name} WHERE id = ${op.id}`;
const tagOf = () => String(Math.floor(Math.random() * 90_000) + 10_000);

test('«Передать…» из карточки: клиент уходит другому оператору, прежний получает 404', async ({ page, browser }) => {
  const tag = tagOf();
  const rop = await makeStaff(`РОП Передача ${tag}`, 'rop');
  const alpha = await makeOperator(1);
  const beta = await makeOperator(0);
  await rename(alpha, `Оператор Альфа ${tag}`);
  await rename(beta, `Оператор Бета ${tag}`);
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${Date.now() + 3_600_000} WHERE id = ${alpha.cardIds[0]!}`;

  await login(page, rop);
  await page.goto(`/clients/${alpha.clientIds[0]!}`);
  expect(await noHorizontalScroll(page)).toBe(true);
  await tap(page.getByRole('button', { name: 'Передать…' }));
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Кому передать').selectOption({ label: `Оператор Бета ${tag}` });
  await tap(dialog.getByRole('button', { name: 'Передать', exact: true }));
  await expect(page.getByText('Клиент передан. Карточек: 1')).toBeVisible();
  const [row] = await sql<{ owner: string }[]>`SELECT owner_user_id AS owner FROM cards WHERE id = ${alpha.cardIds[0]!}`;
  expect(row?.owner).toBe(beta.id);

  // прежний оператор клиента больше не видит; получатель видит
  const alphaCtx = await browser.newContext({ ...(test.info().project.use as object) });
  const alphaPage = await alphaCtx.newPage();
  await login(alphaPage, alpha);
  const gone = await alphaPage.goto(`/clients/${alpha.clientIds[0]!}`);
  expect(gone?.status()).toBe(404);
  await alphaCtx.close();
  const betaCtx = await browser.newContext({ ...(test.info().project.use as object) });
  const betaPage = await betaCtx.newPage();
  await login(betaPage, beta);
  const seen = await betaPage.goto(`/clients/${alpha.clientIds[0]!}`);
  expect(seen?.status()).toBe(200);
  await betaCtx.close();
});

test('массовая передача: предпросмотр счётчиками и одна кнопка «Передать N карточек»', async ({ page }) => {
  const tag = tagOf();
  const rop = await makeStaff(`РОП Массовая ${tag}`, 'rop');
  const alpha = await makeOperator(2);
  const beta = await makeOperator(0);
  await rename(alpha, `Оператор Альфа ${tag}`);
  await rename(beta, `Оператор Бета ${tag}`);

  await login(page, rop);
  const res = await page.goto('/team/transfer');
  test.skip(res?.status() === 404, 'FEATURE_BULK_TRANSFER выключен');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByLabel('От кого').selectOption({ label: `Оператор Альфа ${tag}` });
  await expect(page.getByText('Карточек: 2')).toBeVisible();
  await page.getByLabel('Получатель').selectOption({ label: `Оператор Бета ${tag}` });
  await tap(page.getByRole('button', { name: 'Передать 2 карточки' }));
  await expect(page.getByText('Передано карточек: 2')).toBeVisible();
  const owners = await sql<{ owner: string }[]>`SELECT DISTINCT owner_user_id AS owner FROM cards WHERE id = ANY(${alpha.cardIds})`;
  expect(owners.map((o) => o.owner)).toEqual([beta.id]);
});

test('отключение: сводка, предупреждение, передача дел получателю и возврат новой карточки в пул', async ({ page }) => {
  const tag = tagOf();
  await makeStaff(`РОП Приёмщик ${tag}`, 'rop'); // резервная роль: есть кому принять
  const admin = await makeStaff(`Администратор Передача ${tag}`, null, true);
  const alpha = await makeOperator(2);
  await rename(alpha, `Оператор Уходит ${tag}`);
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${Date.now() + 3_600_000} WHERE id = ${alpha.cardIds[0]!}`;

  await login(page, admin);
  await page.goto('/team');
  expect(await noHorizontalScroll(page)).toBe(true);
  await tap(page.getByRole('button', { name: `Действия: Оператор Уходит ${tag}` }));
  await tap(page.getByRole('button', { name: 'Отключить', exact: true }));
  await expect(page.getByText('Вход закроется сразу, отменить это действие нельзя', { exact: false })).toBeVisible();
  await expect(page.getByText('Рабочих карточек: 1, нетронутых новых вернётся в пул: 1', { exact: false })).toBeVisible();
  await tap(page.getByRole('dialog').getByRole('button', { name: 'Отключить', exact: true }));
  await expect(page.getByText('Передано карточек: 1, возвращено в пул: 1', { exact: false })).toBeVisible();

  const [moved] = await sql<{ owner: string | null }[]>`SELECT owner_user_id AS owner FROM cards WHERE id = ${alpha.cardIds[0]!}`;
  expect(moved?.owner).not.toBeNull();
  expect(moved?.owner).not.toBe(alpha.id);
  const [released] = await sql<{ owner: string | null }[]>`SELECT owner_user_id AS owner FROM cards WHERE id = ${alpha.cardIds[1]!}`;
  expect(released?.owner).toBeNull();
  const [user] = await sql<{ status: string }[]>`SELECT status FROM users WHERE id = ${alpha.id}`;
  expect(user?.status).toBe('disabled');
});
