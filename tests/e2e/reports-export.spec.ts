// Выгрузки на телефоне (R3b): РОП скачивает CSV отчёта (событие download), директор видит строку в журнале выгрузок и
// делает полную выгрузку с повторным паролем (неверный пароль — сообщение, верный — архив); оператору журнала нет.
// Сотрудники создаются прямо в БД приложения (E2E_DATABASE_URL, настройки пресета уже применены); без неё — пропуск.
// Синтетика: номера +7 709 555 xxxx.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as never);
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const phone = () => `7709555${String(Math.floor(Math.random() * 9000) + 1000)}`;

type Staff = { id: string; phone: string; name: string };
let spaceId = '';
let rop: Staff;
let director: Staff;
let operator: Staff;
let tag = 0;

async function makeStaff(role: string, name: string): Promise<Staff> {
  const s = { id: randomUUID(), phone: phone(), name };
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
  tag = Math.floor(Math.random() * 90000) + 10000;
  rop = await makeStaff('rop', `РОП Выгрузки ${tag}`);
  director = await makeStaff('director', `Директор Выгрузки ${tag}`);
  operator = await makeStaff('operator', `Оператор Выгрузки ${tag}`);
});

test.afterAll(async () => {
  await sql?.end();
});

test('РОП скачивает CSV отчёта: файл для Excel с заголовками таблицы', async ({ page }) => {
  await login(page, rop);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 1 })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Выгрузить CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^crm-operators-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const body = await readFile((await file.path()) as string);
  expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(body.toString('utf8')).toContain('Оператор;');
  // РОП журнала не видит (PROCESS 8.6: администратор и директор)
  await expect(page.getByRole('link', { name: 'Журнал выгрузок' })).toHaveCount(0);
});

test('директор видит выгрузку РОП в журнале', async ({ page }) => {
  await login(page, director);
  await page.goto('/reports');
  await page.getByRole('link', { name: 'Журнал выгрузок' }).click();
  await expect(page.getByRole('heading', { name: 'Журнал выгрузок', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(`РОП Выгрузки ${tag}`) }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Отчёт: Операторы');
  await expect(row).toContainText('CSV');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('директор: полная выгрузка — неверный пароль даёт сообщение, верный — архив ZIP', async ({ page }) => {
  await login(page, director);
  await page.goto('/reports');
  await page.getByRole('button', { name: 'Выгрузить все данные' }).click();
  const dialog = page.getByRole('dialog', { name: 'Полная выгрузка данных' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Ваш пароль').fill('неверный-пароль');
  await page.getByRole('button', { name: 'Подтвердить и скачать' }).click();
  await expect(dialog.getByText('Пароль неверный.')).toBeVisible();
  await dialog.getByLabel('Ваш пароль').fill(PASSWORD);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Подтвердить и скачать' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^crm-full-\d{8}-\d{4}\.zip$/);
  const body = await readFile((await file.path()) as string);
  expect(body.subarray(0, 4).toString('hex')).toBe('504b0304');
  await expect(page.getByText('Скачивание началось.', { exact: false })).toBeVisible();
  // в журнале — полная выгрузка директора
  await page.goto('/reports/exports');
  await expect(page.getByRole('row', { name: new RegExp(`Директор Выгрузки ${tag}.*Полная выгрузка`) }).first()).toBeVisible();
});

test('оператор журнала не открывает: страницы нет, API — 403', async ({ page }) => {
  await login(page, operator);
  await page.goto('/reports/exports');
  await expect(page.getByRole('heading', { name: 'Журнал выгрузок', level: 1 })).toHaveCount(0);
  expect((await page.request.get('/api/export/journal')).status()).toBe(403);
});
