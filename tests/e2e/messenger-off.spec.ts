// Мессенджер при выключенном в production FEATURE_WAZZUP (O7a, D-026): кнопка «WhatsApp» в карточке открывает wa.me,
// окна чата нет, в ленту уходит «открыт WhatsApp»; экран «Интеграции» пуст, вебхук отвечает 404.
// Только синтетика (+7 709 …).
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

test('кнопка «WhatsApp» открывает wa.me, окна чата нет, событие попадает в ленту', async ({ page, context }) => {
  const op = await makeOperator(1);
  const [phone] = await sql<{ digits: string }[]>`SELECT digits FROM client_phones WHERE client_id = ${op.clientIds[0]!}`;
  await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'wa.me синтетика' }));
  await login(page, op);
  await page.goto(`/clients/${op.clientIds[0]}`);
  const button = page.getByRole('link', { name: 'Написать клиенту в WhatsApp' });
  await expect(button).toHaveAttribute('href', `https://wa.me/${phone!.digits}`);
  await expect(button).toHaveAttribute('target', '_blank');
  // innerWidth на мобильном раздувается вслед за переполнением, поэтому сравниваем с шириной устройства
  expect(await page.evaluate(() => window.innerWidth)).toBe(page.viewportSize()!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const opened = page.waitForRequest((r) => r.url().endsWith('/api/messenger/opened') && r.method() === 'POST');
  const popup = context.waitForEvent('page');
  await button.click();
  await opened;
  await (await popup).close();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect.poll(async () => (await sql`SELECT 1 FROM client_events WHERE client_id = ${op.clientIds[0]!} AND kind = 'messenger.link_opened'`).length).toBe(1);
  await page.reload();
  // Настоящее нажатие: если сводку перекрывает прозрачный слой, тест должен упасть
  await page.getByText(/Переписка: 1 сообщение/).click();
  await expect(page.getByText('Открыт WhatsApp', { exact: true })).toBeVisible();
});

test('экран «Интеграции» пуст при выключенном флаге, оператору недоступен; вебхук — 404', async ({ page, request }) => {
  const adminId = randomUUID();
  const phone = `7709${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, is_admin, created_at)
            VALUES (${adminId}, ${phone}, 'Администратор Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, TRUE, ${Date.now()})`;
  await login(page, { id: adminId, phone, cardIds: [], names: [], clientIds: [] } satisfies Operator);
  const res = await page.goto('/integrations');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Интеграции', level: 1 })).toBeVisible();
  await expect(page.getByText('Нет подключаемых интеграций.')).toBeVisible();
  // Пункт меню «Интеграции» виден администратору и без флага: через него открывается карточка Beeline
  await expect(page.getByRole('link', { name: 'Интеграции' }).first()).toBeVisible();

  const op = await makeOperator(0);
  await page.context().clearCookies();
  await login(page, op);
  const denied = await page.goto('/integrations');
  expect(denied?.status()).toBe(404);

  const hook = await request.post(`/api/hooks/messenger.wazzup/${'x'.repeat(43)}`, { data: { test: true } });
  expect(hook.status()).toBe(404);
});
