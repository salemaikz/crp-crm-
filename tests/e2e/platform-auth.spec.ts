// Вход по телефону, приглашение, «выйти везде», CSRF. Сотрудник и ссылка создаются прямо в БД
// приложения (E2E_DATABASE_URL — та же база, что у DATABASE_URL запущенного сервера); без неё тесты пропускаются.
// Синтетика: номера 701 555 01 xx.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as never);
// Корень «/» перенаправляет на главную роли. У сотрудника без роли в настройках меню пусто, и главная — «Мой аккаунт».
const HOME = '/account';
const now = () => Date.now();
const uniquePhone = () => `7701555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;

async function makeUser(opts: { password?: string | null } = {}): Promise<{ id: string; phone: string }> {
  const id = randomUUID();
  const phone = uniquePhone();
  const hash = opts.password === null ? null : bcrypt.hashSync(opts.password ?? PASSWORD, 4);
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, ${'Тест Тестов'}, ${hash}, ${now()})`;
  return { id, phone };
}

async function makeInviteFor(userId: string, phone: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await sql`
    INSERT INTO invites (id, token_hash, kind, phone_digits, expires_at, created_by, created_at)
    VALUES (${randomUUID()}, ${hash}, 'invite', ${phone}, ${now() + 3_600_000}, ${userId}, ${now()})`;
  return token;
}

async function loginVia(page: Page, phone: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(phone));
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

test.afterAll(async () => {
  await sql?.end();
});

test('вход по телефону: «8 701…», cookie HttpOnly и Lax, поле открывает цифровую клавиатуру', async ({ page, context }) => {
  const u = await makeUser();
  await page.goto('/login');
  await expect(page.getByLabel('Номер телефона')).toHaveAttribute('inputmode', 'tel');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await loginVia(page, u.phone, PASSWORD);
  await page.waitForURL(HOME);
  const cookie = (await context.cookies()).find((c) => c.name === 'crm_sid' || c.name === '__Host-crm_sid');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
});

test('неверный пароль: текст ошибки, cookie нет', async ({ page, context }) => {
  const u = await makeUser();
  await loginVia(page, u.phone, 'неверный-пароль-1');
  await expect(page.locator('p[role="alert"]')).toHaveText('Неверный номер или пароль');
  expect((await context.cookies()).some((c) => c.name.endsWith('crm_sid'))).toBe(false);
});

test('приглашение: адрес без #, пароль дважды, вход; повторная ссылка недействительна', async ({ page, browser }) => {
  const admin = await makeUser();
  const u = await makeUser({ password: null });
  const token = await makeInviteFor(admin.id, u.phone);
  await page.goto(`/invite#${token}`);
  await expect(page.getByRole('button', { name: 'Сохранить и войти' })).toBeVisible();
  expect(page.url()).not.toContain('#');
  expect(page.url()).not.toContain(token);
  await page.getByLabel('Новый пароль').fill('Новый-пароль-66');
  await page.getByLabel('Повторите пароль').fill('Новый-пароль-66');
  await page.getByRole('button', { name: 'Сохранить и войти' }).click();
  await page.waitForURL(HOME);
  const other = await (await browser.newContext()).newPage();
  await other.goto(`/invite#${token}`);
  await expect(other.locator('p[role="alert"]')).toContainText('Ссылка недействительна');
});

test('«выйти везде»: вторая сессия при следующем переходе возвращается на вход', async ({ browser }) => {
  const u = await makeUser();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await loginVia(a, u.phone, PASSWORD);
  await a.waitForURL(HOME);
  await loginVia(b, u.phone, PASSWORD);
  await b.waitForURL(HOME);
  await a.goto('/account');
  await a.getByRole('button', { name: 'Выйти на всех устройствах' }).click();
  await a.getByRole('button', { name: 'Выйти на всех устройствах' }).click();
  await a.waitForURL(/\/login/);
  await b.goto('/account');
  await b.waitForURL(/\/login/);
});

test('POST /api/auth/login с чужим Origin и без Origin — 403', async ({ request, baseURL }) => {
  const body = { phone: '87015550101', password: 'x' };
  const foreign = await request.post('/api/auth/login', { data: body, headers: { Origin: 'https://evil.test' } });
  expect(foreign.status()).toBe(403);
  const none = await request.post('/api/auth/login', { data: body, headers: { Origin: '' } });
  expect(none.status()).toBe(403);
  const own = await request.post('/api/auth/login', { data: body, headers: { Origin: baseURL as string } });
  expect(own.status()).toBe(401);
});
