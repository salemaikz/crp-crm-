// Настройки продаж РОП на телефоне: лимит сохраняется, конфликт ревизий, оператору экрана нет.
// Сотрудники создаются прямо в БД приложения (E2E_DATABASE_URL, настройки пресета уже применены); без неё — пропуск.
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

type Staff = { id: string; phone: string };
let spaceId = '';
let rop: Staff;
let operator: Staff;

async function makeStaff(role: string, name: string): Promise<Staff> {
  const s = { id: randomUUID(), phone: await phone() };
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
  const space = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE is_default LIMIT 1`;
  spaceId = space[0]?.id ?? '';
  const tag = Math.floor(Math.random() * 90000) + 10000;
  rop = await makeStaff('rop', `РОП Настройки ${tag}`);
  operator = await makeStaff('operator', `Оператор Настройки ${tag}`);
});
test.afterAll(async () => {
  await sql?.end();
});

const CAP = 'Лимит карточек на оператора в день';

test('РОП меняет лимит: сохранено и видно после перезагрузки, без горизонтальной прокрутки', async ({ page }) => {
  await login(page, rop);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Настройки продаж', level: 1 })).toBeVisible();
  const cap = page.getByLabel(CAP);
  const next = String(30 + Math.floor(Math.random() * 20));
  await cap.fill(next);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Сохранено')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(CAP)).toHaveValue(next);
  // праздники РОП видит, но не правит
  await expect(page.getByText('Календарь меняет администратор.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить день' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('конфликт ревизий: чужая правка → предупреждение, «Обновить» подтягивает свежее значение', async ({ page }) => {
  await login(page, rop);
  await page.goto('/settings');
  await expect(page.getByLabel(CAP)).toBeVisible();
  // «другой сотрудник» меняет лимит через API с актуальными ревизиями
  const origin = new URL(page.url()).origin;
  const cur = await (await page.request.get('/api/admin/settings/sales')).json();
  const other = String((Number(cur.values.dailyCap) % 50) + 1);
  const res = await page.request.patch('/api/admin/settings/sales', {
    headers: { Origin: origin },
    data: { expectedRev: cur.revs, patch: { dailyCap: Number(other) } },
  });
  expect(res.status()).toBe(200);
  await page.getByLabel(CAP).fill('77');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Настройки изменил другой сотрудник. Обновите страницу.')).toBeVisible();
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByLabel(CAP)).toHaveValue(other);
});

test('оператору экрана настроек нет, API отвечает 403', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, operator);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Настройки продаж', level: 1 })).toHaveCount(0);
  expect((await page.request.get('/api/admin/settings/sales')).status()).toBe(403);
  await page.context().close();
});
