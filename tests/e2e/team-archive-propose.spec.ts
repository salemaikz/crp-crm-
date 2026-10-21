// C9 на телефоне: «Мои клиенты» и архив, «Вернуть в обзвон» (РОП), «Предложить контакт» (оператор) и разбор РОП.
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

test('оператор: «Мои клиенты», архив с причиной и датой возврата, «Предложить контакт» без подробностей проверки', async ({ page }) => {
  const op = await makeOperator(3);
  const t = Date.now();
  await sql`UPDATE cards SET state = 'agreed' WHERE id = ${op.cardIds[0]!}`;
  await sql`UPDATE cards SET state = 'not_interested', close_reason_code = 'expensive', closed_at = ${t}, return_at = ${t + 90 * 86_400_000} WHERE id = ${op.cardIds[1]!}`;

  await login(page, op);
  await page.goto('/clients');
  expect(await noHorizontalScroll(page)).toBe(true);
  await tap(page.getByRole('link', { name: 'Мои клиенты' }));
  await expect(page.getByText(op.names[0]!)).toBeVisible();
  await expect(page.getByText(op.names[2]!)).toHaveCount(0);

  await page.goto('/archive');
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(page.getByText(op.names[1]!)).toBeVisible();
  await expect(page.getByText('Вернётся')).toBeVisible();
  await expect(page.getByText(op.names[0]!)).toHaveCount(0);

  // «Предложить контакт»: чужой номер и свободный — один и тот же ответ
  const taken = (await sql<{ digits: string }[]>`SELECT digits FROM client_phones WHERE client_id = ${op.clientIds[2]!}`)[0]!.digits;
  for (const digits of [taken, await phone()]) {
    await page.goto('/clients');
    await tap(page.getByRole('button', { name: 'Предложить контакт' }));
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Номер телефона').fill(`+${digits}`);
    await sheet.getByLabel('Название').fill('ТОО Синтетика Предложенная');
    await tap(sheet.getByRole('button', { name: 'Отправить' }));
    await expect(page.getByText('Принято. Карточка появится в очереди после проверки')).toBeVisible();
  }
  const mine = await sql<{ status: string }[]>`SELECT status FROM proposals WHERE user_id = ${op.id} ORDER BY created_at`;
  expect(mine).toHaveLength(2);
});

test('РОП: «Вернуть в обзвон» из архива и разбор предложенных операторами', async ({ page }) => {
  const rop = await makeRop();
  const op = await makeOperator(1);
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const t = Date.now();
  await sql`UPDATE cards SET state = 'not_target', close_reason_code = 'other', closed_at = ${t} WHERE id = ${op.cardIds[0]!}`;
  const proposalId = randomUUID();
  const proposalName = `ТОО Синтетика На Разборе ${proposalId.slice(0, 8)}`;
  await sql`INSERT INTO proposals (id, space_id, user_id, digits, name, status, created_at)
            VALUES (${proposalId}, ${space!.id}, ${op.id}, ${await phone()}, ${proposalName}, 'review', ${t})`;

  await login(page, rop);
  await page.goto(`/clients/${op.clientIds[0]!}`);
  expect(await noHorizontalScroll(page)).toBe(true);
  await tap(page.getByRole('button', { name: 'Вернуть в обзвон' }));
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Комментарий').fill('Появился бюджет');
  await tap(dialog.getByRole('button', { name: 'Подтвердить' }));
  await expect(page.getByText('Карточка возвращена в обзвон')).toBeVisible();
  await expect.poll(async () => (await sql<{ state: string }[]>`SELECT state FROM cards WHERE id = ${op.cardIds[0]!}`)[0]?.state).toBe('callback');

  await page.goto('/distribution');
  await tap(page.getByRole('tab', { name: /Предложены операторами/ }));
  await expect(page.getByText(proposalName)).toBeVisible();
  await tap(page.getByRole('row').filter({ hasText: proposalName }).getByRole('button', { name: 'Отклонить' }));
  await expect(page.getByText('Предложение отклонено')).toBeVisible();
  await expect.poll(async () => (await sql<{ status: string }[]>`SELECT status FROM proposals WHERE id = ${proposalId}`)[0]?.status).toBe('rejected');
});
