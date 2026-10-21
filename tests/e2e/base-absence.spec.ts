// C6b на телефоне РОП: «Отсутствует» оператору А с заместителем Б; Б видит перезвон А в «Звонить»; РОП отменяет —
// у Б карточки нет. Нужна БД e2e (E2E_DATABASE_URL). Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, cardTitle, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';
import { uniquePhone } from './support/phones';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

const phone = () => uniquePhone(sql);

async function makeRop(name: string): Promise<Operator> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const p = await phone();
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${p}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'rop', FALSE, ${t}, ${t})`;
  return { id, phone: p, cardIds: [], names: [], clientIds: [] };
}

async function rename(op: Operator, name: string): Promise<void> {
  await sql`UPDATE users SET name = ${name} WHERE id = ${op.id}`;
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('РОП ставит «Отсутствует» с заместителем: Б видит перезвон А, после отмены карточки у Б нет', async ({ page, browser }) => {
  const tag = String(Math.floor(Math.random() * 90_000) + 10_000);
  const rop = await makeRop(`РОП Отсутствие ${tag}`);
  const alpha = await makeOperator(1);
  const beta = await makeOperator(0);
  await rename(alpha, `Оператор Альфа ${tag}`);
  await rename(beta, `Оператор Бета ${tag}`);
  // перезвон А просрочен на час: в «Звонить» попадает сразу
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${Date.now() - 3_600_000} WHERE id = ${alpha.cardIds[0]!}`;

  await login(page, rop);
  await page.goto('/distribution');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByRole('tab', { name: /Участники/ }).click();
  await page.getByRole('button', { name: `Отметить отсутствие: Оператор Альфа ${tag}` }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Кому передать').selectOption({ label: `Оператор Бета ${tag}` });
  await sheet.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Временно передано: 1, вернулось в пул: 0')).toBeVisible();

  const [row] = await sql<{ acting: string | null; owner: string }[]>`SELECT acting_user_id AS acting, owner_user_id AS owner FROM cards WHERE id = ${alpha.cardIds[0]!}`;
  expect(row).toEqual({ acting: beta.id, owner: alpha.id });

  // Б на своём телефоне: карточка А в «Звонить»
  const betaCtx = await browser.newContext({ ...(test.info().project.use as object) });
  const betaPage = await betaCtx.newPage();
  await login(betaPage, beta);
  await betaPage.goto('/call');
  await expect(betaPage.getByTestId('call-card')).toBeVisible();
  await expect(cardTitle(betaPage)).toHaveText(alpha.names[0]!);

  // РОП отменяет: список отсутствий, «Отменить»
  await expect(page.getByRole('heading', { name: 'Отсутствия' })).toBeVisible();
  await page.getByRole('button', { name: `Отменить отсутствие: Оператор Альфа ${tag}` }).click();
  await expect(page.getByText(`Отсутствие отменено: Оператор Альфа ${tag}`)).toBeVisible();
  const [after] = await sql<{ acting: string | null }[]>`SELECT acting_user_id AS acting FROM cards WHERE id = ${alpha.cardIds[0]!}`;
  expect(after?.acting).toBeNull();
  await betaPage.reload();
  await expect(betaPage.getByTestId('call-card')).toHaveCount(0);
  await betaCtx.close();
});

test('«Пауза»: статус меняется на «Пауза» и снимается', async ({ page }) => {
  const tag = String(Math.floor(Math.random() * 90_000) + 10_000);
  const rop = await makeRop(`РОП Пауза ${tag}`);
  const op = await makeOperator(0);
  await rename(op, `Оператор Пауза ${tag}`);
  await sql`UPDATE memberships SET in_distribution = TRUE WHERE user_id = ${op.id}`;
  await login(page, rop);
  await page.goto('/distribution');
  await page.getByRole('tab', { name: /Участники/ }).click();
  await page.getByRole('button', { name: `Поставить на паузу на сегодня: Оператор Пауза ${tag}` }).click();
  await expect(page.getByRole('button', { name: `Снять паузу: Оператор Пауза ${tag}` })).toBeVisible();
  await page.getByRole('button', { name: `Снять паузу: Оператор Пауза ${tag}` }).click();
  await expect(page.getByRole('button', { name: `Поставить на паузу на сегодня: Оператор Пауза ${tag}` })).toBeVisible();
});

test('«Без владельца (не новые)»: РОП выбирает карточку и назначает оператору', async ({ page }) => {
  const tag = String(Math.floor(Math.random() * 90_000) + 10_000);
  const rop = await makeRop(`РОП Раздел ${tag}`);
  const op = await makeOperator(0);
  await rename(op, `Оператор Раздел ${tag}`);
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const clientId = randomUUID();
  const cardId = randomUUID();
  const name = `ТОО Синтетика Без владельца ${tag}`;
  const t = Date.now();
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', ${name}, ${name.toLowerCase()}, ${name.toLowerCase()}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${randomUUID()}, ${clientId}, ${await phone()}, 'mobile', TRUE, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, next_call_at, created_at, updated_at)
            VALUES (${cardId}, ${space!.id}, ${clientId}, NULL, 'callback', ${t + 3_600_000}, ${t}, ${t})`;

  await login(page, rop);
  await page.goto('/distribution');
  await page.getByRole('tab', { name: /Без владельца/ }).click();
  await page.getByRole('checkbox', { name: `Выбрать карточку: ${name}` }).check();
  await page.getByRole('button', { name: 'Назначить' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox').selectOption({ label: `Оператор Раздел ${tag}` });
  await dialog.getByRole('button', { name: 'Назначить' }).click();
  await expect(page.getByText('Назначено: 1, пропущено: 0')).toBeVisible();
  const [row] = await sql<{ owner: string | null }[]>`SELECT owner_user_id AS owner FROM cards WHERE id = ${cardId}`;
  expect(row?.owner).toBe(op.id);
});
