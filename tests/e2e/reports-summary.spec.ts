// Сводка дня РОП на телефоне: плитки, таблица операторов, «Обновить», красная плитка при просрочке, отказ оператору.
// Сотрудники, карточки и устройство создаются прямо в БД приложения (E2E_DATABASE_URL — та же база, что у DATABASE_URL
// сервера; настройки пресета уже применены `crmctl config apply`); без неё тесты пропускаются. Синтетика: номера +7 709 … без коллизий в прогоне (support/phones.ts).
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';
import { pretty, runTag, uniquePhone } from './support/phones';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as never);
// Метка прогона в именах: строку оператора ищем по ней — остатки прошлых попыток в той же БД не мешают
const TAG = runTag();

type Staff = { id: string; phone: string; name: string };
let spaceId = '';
let rop: Staff;
let operator: Staff;
let consultant: Staff;

async function makeStaff(role: string, name: string, inDistribution = false): Promise<Staff> {
  const s = { id: randomUUID(), phone: await uniquePhone(sql), name };
  const now = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${s.id}, ${s.phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${now})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${s.id}, ${spaceId}, ${role}, ${inDistribution}, ${now}, ${now})`;
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
  rop = await makeStaff('rop', `РОП Сводка ${TAG}`);
  operator = await makeStaff('operator', `Оператор Сводка ${TAG}`, true);
  consultant = await makeStaff('consultant', `Консультант Сводка ${TAG}`);
  // у оператора просроченный перезвон и неотправленные итоги на устройстве
  const now = Date.now();
  const clientId = randomUUID();
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', 'ТОО Синтетика Сводка', 'синтетика сводка', 'синтетика сводка', 'import', ${now}, ${now})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, next_call_at, created_at, updated_at)
            VALUES (${randomUUID()}, ${spaceId}, ${clientId}, ${operator.id}, 'callback', ${now - 3 * 3_600_000}, ${now}, ${now})`;
  await sql`INSERT INTO device_status (user_id, device_id, pending_outbox, last_flush_at, seen_at) VALUES (${operator.id}, ${'e2e-' + TAG}, 7, NULL, ${now})`;
});

test.afterAll(async () => {
  await sql?.end();
});

test('РОП открывает сводку: плитки, красная просрочка, оператор в таблице, без горизонтальной прокрутки', async ({ page }) => {
  await login(page, rop);
  await page.goto('/summary');
  await expect(page.getByRole('heading', { name: 'Сводка дня', level: 1 })).toBeVisible();
  const tiles = page.getByRole('region', { name: 'Показатели дня' });
  await expect(tiles.getByText('Просроченные перезвоны')).toBeVisible();
  await expect(tiles.getByText('Не отправлено с устройств')).toBeVisible();
  await expect(tiles.getByText('Роздано сегодня')).toBeVisible();
  // плитки «сбор базы» нет (D-056)
  await expect(page.getByText(/сбор базы/i)).toHaveCount(0);
  // просрочка → красное число
  await expect(page.locator('.k-stat--danger')).toHaveCount(1);
  // оператор виден в таблице, неотправленные показаны
  const row = page.getByRole('row', { name: new RegExp(operator.name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('7');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('сводка → действие: просрочка и «Записи» ведут на доску и в записи, без OP_BOARD ссылок нет (A7)', async ({ page }) => {
  await login(page, rop);
  await page.goto('/summary');
  await expect(page.getByRole('heading', { name: 'Сводка дня', level: 1 })).toBeVisible();
  const links = page.locator('[data-testid^="summary-link-"]');
  if (process.env.FEATURE_OP_BOARD !== '1') {
    await expect(links).toHaveCount(0);
    return;
  }
  await expect(page.getByTestId('summary-link-overdue')).toHaveAttribute('href', '/deals/calling?tab=callback&f=today');
  await expect(page.getByTestId('summary-link-bookings')).toHaveAttribute('href', '/bookings');
  const row = page.getByRole('row', { name: new RegExp(operator.name) });
  await expect(row.getByTestId('summary-link-overdue-op')).toHaveAttribute('href', new RegExp(`^/deals/calling\\?tab=callback&f=today&owner=${operator.id}$`));
});

test('«Обновить» перечитывает данные и не ломает экран', async ({ page }) => {
  await login(page, rop);
  await page.goto('/summary');
  const refresh = page.getByRole('button', { name: 'Обновить' });
  const reply = page.waitForResponse((r) => r.url().endsWith('/api/reports/summary') && r.status() === 200);
  await refresh.click();
  await reply;
  await expect(page.getByText(/Обновлено в \d{2}:\d{2}/)).toBeVisible();
  await expect(refresh).toBeEnabled();
});

test('оператор и консультант сводку не открывают, API отвечает 403', async ({ browser }) => {
  for (const who of [operator, consultant]) {
    const page = await (await browser.newContext()).newPage();
    await login(page, who);
    await page.goto('/summary');
    await expect(page.getByRole('heading', { name: 'Сводка дня', level: 1 })).toHaveCount(0);
    const res = await page.request.get('/api/reports/summary');
    expect(res.status()).toBe(403);
    await page.context().close();
  }
});

test('гость: API отвечает 401', async ({ request }) => {
  const res = await request.get('/api/reports/summary');
  expect(res.status()).toBe(401);
});

// Дефект 8 (круг 3): таблица операторов на ноутбуке не вылезает за окно; при нехватке места прокручивается обёртка
for (const width of [1280, 1440]) {
  test.describe(`таблица операторов, ${width}×900`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: false, hasTouch: false });

    test('правый край таблицы и обёртки в окне, у документа нет горизонтальной прокрутки, числа tabular-nums', async ({ page }) => {
      await login(page, rop);
      await page.goto('/summary');
      const row = page.getByRole('row', { name: new RegExp(operator.name) });
      await expect(row).toBeVisible();
      const wrap = page.locator('.k-table-wrap').filter({ has: row });
      const box = await wrap.evaluate((el) => {
        const t = el.querySelector('table')!.getBoundingClientRect();
        const w = el.getBoundingClientRect();
        return { tableRight: t.right, wrapRight: w.right, inner: window.innerWidth, docScroll: document.documentElement.scrollWidth, overflowX: getComputedStyle(el).overflowX };
      });
      expect(box.wrapRight).toBeLessThanOrEqual(box.inner);
      expect(box.docScroll).toBeLessThanOrEqual(box.inner);
      // таблица либо целиком в окне, либо прокручивается внутри обёртки
      if (width >= 1440) expect(box.tableRight, 'на 1440 таблица целиком в окне').toBeLessThanOrEqual(box.inner);
      else if (box.tableRight > box.inner) expect(box.overflowX).toBe('auto');
      const num = await row.locator('td[data-numeric]').first().evaluate((el) => getComputedStyle(el).fontVariantNumeric);
      expect(num).toContain('tabular-nums');
      // первая колонка липкая
      const pos = await row.locator('td').first().evaluate((el) => getComputedStyle(el).position);
      expect(pos).toBe('sticky');
    });
  });
}
