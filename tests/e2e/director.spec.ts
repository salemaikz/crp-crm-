// Панель директора на телефоне (R4): директор открывает /director, видит плитки недели, воронку и выручку, пункт меню
// «Панель директора»; кнопок изменения нет, мутация даёт 423; оператору экрана нет. Сотрудники создаются прямо в БД
// приложения (E2E_DATABASE_URL); без неё — пропуск. Синтетика: номера +7 709 555 xxxx.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';
import { uniquePhone } from './support/phones';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as never);
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const phone = () => uniquePhone(sql);

type Staff = { id: string; phone: string; name: string };
let spaceId = '';
let director: Staff;
let operator: Staff;

async function makeStaff(role: string, name: string): Promise<Staff> {
  const s = { id: randomUUID(), phone: await phone(), name };
  const now = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${s.id}, ${s.phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${now})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${s.id}, ${spaceId}, ${role}, false, ${now}, ${now})`;
  return s;
}

async function login(page: Page, s: Staff): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(s.phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test.beforeAll(async () => {
  // миграции и настройки пресета (идемпотентно)
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/support/prepare-db.ts'], { stdio: 'inherit', env: { ...process.env } });
  const space = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE is_default LIMIT 1`;
  spaceId = space[0]?.id ?? '';
  const tag = Math.floor(Math.random() * 90000) + 10000;
  director = await makeStaff('director', `Директор Панель ${tag}`);
  operator = await makeStaff('operator', `Оператор Панель ${tag}`);
});

test.afterAll(async () => {
  await sql?.end();
});

test('директор: панель недели, пункт меню, без кнопок изменения, мутация даёт 423', async ({ page }) => {
  await login(page, director);
  await page.goto('/director');
  await expect(page.getByRole('heading', { name: 'Панель директора', level: 1 })).toBeVisible();
  const tiles = page.getByRole('region', { name: 'Показатели недели' });
  for (const title of ['Итоги и дозвоны', 'Записи', 'Покупки', 'Запас пула']) await expect(tiles.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Воронка недели' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Выручка по типам услуг' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Панель директора' }).first()).toBeVisible();
  // из действий только «Обновить» и ссылки «Подробнее»; форм и полей ввода нет
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Обновить' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Подробнее' }).first()).toHaveAttribute('href', /\/reports\?r=funnel&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  // страница без горизонтальной прокрутки
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // мутация от директора блокируется ролью «только чтение»
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/admin/settings/sales', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    return res.status;
  });
  expect(status).toBe(423);
  // обновление берёт данные из того же API
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByRole('heading', { name: 'Панель директора', level: 1 })).toBeVisible();
});

test('оператору панели нет', async ({ page }) => {
  await login(page, operator);
  const res = await page.goto('/director');
  expect(res?.status()).toBe(404);
});
