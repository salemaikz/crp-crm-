// Кабинет РОП (B4, B5a): «Мероприятия» — дежурные и отмена; «Консультанты» — добавить и выключить.
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у запущенного сервера).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, prepareDb, seedGroupEvents, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(() => prepareDb());

// Тексты, которые меняются вместе с нейтральной формулировкой, — из локали: смена текста не ломает спек молча
const bookingRu = JSON.parse(readFileSync(join(process.cwd(), 'messages', 'ru', 'booking.json'), 'utf8')) as { events: { noDuty: string } };

async function makeStaff(role: string, name: string): Promise<{ id: string; phone: string }> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = `7709${digits(7)}`;
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, ${role}, FALSE, ${t}, ${t})`;
  return { id, phone };
}

async function loginAs(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

test('РОП: мероприятия — назначить дежурного и отменить', async ({ page }) => {
  const tag = digits(5);
  const rop = await makeStaff('rop', `РОП Синтетик ${tag}`);
  const duty = await makeStaff('operator', `Дежурный Синтетик ${tag}`);
  const eventId = randomUUID();
  await seedGroupEvents([{ id: eventId, plusDays: 3 }]);
  await loginAs(page, rop.phone);

  await page.goto('/bookings/events');
  await expect(page.getByTestId('event-card')).toHaveCount(1);
  await expect(page.getByText('Мест: 0 из 30')).toBeVisible();
  await expect(page.getByText(bookingRu.events.noDuty)).toBeVisible();
  expect(await noHScroll(page)).toBe(true);

  await page.getByRole('button', { name: 'Назначить дежурных' }).click();
  await page.getByLabel(`Дежурный Синтетик ${tag}`).check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Дежурные сохранены')).toBeVisible();
  await expect(page.getByTestId('event-card').getByText(`Дежурный Синтетик ${tag}`)).toBeVisible();
  const saved = await sql<{ userId: string }[]>`SELECT user_id AS "userId" FROM event_duty WHERE event_id = ${eventId}`;
  expect(saved.map((r) => r.userId)).toEqual([duty.id]);

  await page.getByRole('button', { name: 'Отменить мероприятие' }).first().click();
  await expect(page.getByText(/Отменить мероприятие\? Записи станут/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Отменить мероприятие' }).click();
  await expect(page.getByTestId('event-card')).toHaveCount(0);
  const [ev] = await sql<{ status: string }[]>`SELECT status FROM events WHERE id = ${eventId}`;
  expect(ev?.status).toBe('cancelled');
});

test('РОП: консультанты — добавить сотрудника и выключить', async ({ page }) => {
  const tag = digits(5);
  const rop = await makeStaff('rop', `РОП Синтетик ${tag}`);
  const person = await makeStaff('operator', `Консультант Синтетик ${tag}`);
  await loginAs(page, rop.phone);

  await page.goto('/consultants');
  expect(await noHScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Добавить консультанта' }).click();
  await page.getByLabel('Сотрудник').selectOption({ label: `Консультант Синтетик ${tag}` });
  await page.getByLabel('Маркетинг').check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Консультант добавлен')).toBeVisible();
  const card = page.getByTestId('consultant-card').filter({ hasText: `Консультант Синтетик ${tag}` });
  await expect(card).toBeVisible();
  await expect(card.getByText('Работает')).toBeVisible();
  await expect(card.getByText('Маркетинг')).toBeVisible();

  await card.getByRole('button', { name: 'Выключить' }).click();
  await expect(card.getByText('Выключен')).toBeVisible();
  const [r] = await sql<{ active: boolean }[]>`SELECT active FROM resources WHERE user_id = ${person.id}`;
  expect(r?.active).toBe(false);
  await page.reload();
  await expect(page.getByTestId('consultant-card').filter({ hasText: `Консультант Синтетик ${tag}` }).getByText('Выключен')).toBeVisible();
});
