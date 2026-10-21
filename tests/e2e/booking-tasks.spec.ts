// B7 на телефоне: оператор ставит задачу из карточки своего клиента → она в «Задачах» → комментарий → «Готово»;
// РОП: «Команда» с фильтром по сотруднику, «Без исполнителя» → «Взять себе». Нужна БД e2e (E2E_DATABASE_URL).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
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

async function makeRop(name: string): Promise<Operator> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const p = await phone();
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${p}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'rop', FALSE, ${t}, ${t})`;
  return { id, phone: p, cardIds: [], names: [], clientIds: [] };
}

/** Липкая кнопка «Позвонить» в карточке перекрывает нижний край: нажимаем самим элементом. */
async function tap(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((el) => (el as HTMLElement).click());
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Местный час установки (Алматы): «Сегодня 18:00» после 18:00 уже просрочено. */
const almatyHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Almaty' }).format(Date.now()));

test('оператор: «+ Задача» в карточке → в «Задачах» на сегодня → комментарий → «Готово»', async ({ page }) => {
  const tag = String(Math.floor(Math.random() * 90_000) + 10_000);
  const op = await makeOperator(1);
  const clientId = op.clientIds[0]!;
  const title = `Отправить КП ${tag}`;

  await login(page, op);
  await page.goto(`/clients/${clientId}`);
  const panel = page.getByTestId('client-tasks');
  await expect(panel).toContainText('Открытых задач нет.');
  // Карточка не шире экрана: иначе шторка задачи уезжает за правый край и кнопки недоступны
  expect(await noHorizontalScroll(page)).toBe(true);
  await tap(panel.getByRole('button', { name: 'Задача' }));
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('new-task-client')).toHaveText(op.names[0]!);
  await sheet.getByRole('button', { name: 'Сегодня 18:00' }).click();
  await expect(sheet.getByRole('button', { name: 'Сегодня 18:00' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByLabel('Что сделать').fill(title);
  await tap(sheet.getByRole('button', { name: 'Создать задачу' }));
  await expect(sheet).toBeHidden();
  await expect(panel.getByTestId('task-title').filter({ hasText: title })).toBeVisible();

  const [row] = await sql<{ id: string; source: string; assignee: string }[]>`
    SELECT id, source, assignee_user_id AS assignee FROM tasks WHERE client_id = ${clientId} AND title = ${title}`;
  expect(row).toMatchObject({ source: 'manual', assignee: op.id });

  // Экран «Задачи»: группа «Сегодня» (после 18:00 по Алматы — «Просрочено»)
  await page.goto('/tasks');
  expect(await noHorizontalScroll(page)).toBe(true);
  const bucket = page.getByTestId(almatyHour() < 18 ? 'bucket-today' : 'bucket-overdue');
  await expect(bucket.getByTestId('task-title').filter({ hasText: title })).toBeVisible();
  await bucket.getByRole('button', { name: new RegExp(title) }).click();

  const detail = page.getByRole('dialog');
  await expect(detail.getByTestId('task-detail')).toBeVisible();
  await detail.getByLabel('Новый комментарий').fill('Отправил на почту');
  await tap(detail.getByRole('button', { name: 'Добавить комментарий' }));
  await expect(detail.getByTestId('task-comment').filter({ hasText: 'Отправил на почту' })).toBeVisible();

  await tap(detail.getByRole('button', { name: 'Готово' }));
  await expect(detail).toBeHidden();
  await expect(page.getByTestId('task-title').filter({ hasText: title })).toHaveCount(0);
  const [done] = await sql<{ status: string; comments: number }[]>`
    SELECT status, (SELECT count(*)::int FROM task_comments WHERE task_id = ${row!.id}) AS comments FROM tasks WHERE id = ${row!.id}`;
  expect(done).toEqual({ status: 'done', comments: 1 });

  await page.getByRole('tab', { name: /Выполненные/ }).click();
  await expect(page.getByTestId('task-title').filter({ hasText: title })).toBeVisible();
});

test('РОП: «Команда» с фильтром по сотруднику, «Без исполнителя» → «Взять себе»', async ({ page }) => {
  const tag = String(Math.floor(Math.random() * 90_000) + 10_000);
  const rop = await makeRop(`РОП Задачи ${tag}`);
  const op = await makeOperator(1);
  await sql`UPDATE users SET name = ${`Оператор Задачи ${tag}`} WHERE id = ${op.id}`;
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const t = Date.now();
  const opTitle = `Уточнить реквизиты ${tag}`;
  await sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, created_by, created_at)
            VALUES (${randomUUID()}, ${space!.id}, ${op.clientIds[0]!}, 'call', 'manual', ${opTitle}, ${t + 86_400_000}, ${op.id}, 'open', ${op.id}, ${t})`;
  const freeId = randomUUID();
  await sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, status, created_at)
            VALUES (${freeId}, ${space!.id}, ${op.clientIds[0]!}, 'check', 'stoplist_confirm', '', NULL, 'open', ${t})`;

  await login(page, rop);
  await page.goto('/tasks');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByRole('tab', { name: /Команда/ }).click();
  await page.getByLabel('Сотрудник').selectOption({ label: `Оператор Задачи ${tag}` });
  const opRow = page.getByTestId('task-title').filter({ hasText: opTitle });
  await expect(opRow).toBeVisible();
  // Строка «Команды» показывает исполнителя
  await expect(page.getByRole('button', { name: new RegExp(opTitle) })).toContainText(`Оператор Задачи ${tag}`);

  await page.getByRole('tab', { name: /Без исполнителя/ }).click();
  await page.getByRole('button', { name: new RegExp(`Подтвердить стоп-лист.*${op.names[0]!}`) }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByTestId('task-detail')).toBeVisible();
  // Автозадача разбора закрывается «Готово»; РОП сначала берёт её себе
  await detail.getByRole('button', { name: 'Взять себе' }).click();
  await expect(detail.getByText(`РОП Задачи ${tag}`)).toBeVisible();
  const [taken] = await sql<{ assignee: string | null }[]>`SELECT assignee_user_id AS assignee FROM tasks WHERE id = ${freeId}`;
  expect(taken?.assignee).toBe(rop.id);
});
