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
  for (const title of ['Итоги', 'Дозвоны', 'Покупки', 'В пуле']) await expect(tiles.getByText(title, { exact: true })).toBeVisible();
  await expect(tiles.getByText(/^Записи на /).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Воронка недели' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Выручка по типам услуг' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Панель директора' }).first()).toBeVisible();
  // из действий только «Обновить» и ссылки «Подробнее»; форм и полей ввода нет
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Обновить' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Подробнее', exact: true }).first()).toHaveAttribute('href', /\/reports\?r=\w+&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
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

test('директор на ноутбуке: плитки недели, отдельные «Итоги» и «Дозвоны», снимок', async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page, director);
  await page.goto('/director');
  const tiles = page.getByRole('region', { name: 'Показатели недели' });
  await expect(tiles.getByText('Итоги', { exact: true })).toBeVisible();
  await expect(tiles.getByText('Дозвоны', { exact: true })).toBeVisible();
  await expect(tiles.getByText('В пуле', { exact: true })).toBeVisible();
  await expect(tiles.getByText('Итоги и дозвоны')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await info.attach('director-laptop', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('оператору панели нет', async ({ page }) => {
  await login(page, operator);
  const res = await page.goto('/director');
  expect(res?.status()).toBe(404);
});

test('телефон: подписи плиток недели и шагов воронки не перекрываются (A2)', async ({ page }) => {
  test.skip(test.info().project.name !== 'pixel-7', 'геометрия проверяется на Pixel 7');
  await login(page, director);
  await page.goto('/director');
  await expect(page.getByRole('heading', { name: 'Воронка недели' })).toBeVisible();
  for (const name of ['Показатели недели', 'Воронка недели']) {
    const grid = page.getByRole('region', { name });
    const boxes = await grid.locator('.k-stat').evaluateAll((els) =>
      els.map((e) => {
        const r = (e.querySelector('.k-stat__label') ?? e).getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }),
    );
    expect(boxes.length).toBeGreaterThan(3);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
        expect(overlap, `${name}: подписи ${i} и ${j} перекрываются`).toBe(false);
      }
    }
    // плитки в две колонки: у первых двух общая верхняя граница, правая колонка не уходит за экран
    const tiles = await grid.locator('.k-stat').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    expect(Math.abs(tiles[0]!.top - tiles[1]!.top)).toBeLessThan(2);
    expect(tiles.every((r) => r.right <= page.viewportSize()!.width + 0.5)).toBe(true);
  }
});

test('переключатель «Эта неделя / Прошлая неделя» и блок причин отказа (A3)', async ({ page }) => {
  await login(page, director);
  await page.goto('/director');
  await expect(page.getByTestId('week-current')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/^Текущая неделя:/)).toBeVisible();
  await page.getByTestId('week-prev').click();
  await expect(page).toHaveURL(/\/director\?week=prev$/);
  await expect(page.getByText(/^Прошлая неделя: \d/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Причины отказа/ })).toBeVisible();
  // обновление берёт ту же неделю
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByText(/^Прошлая неделя: \d/)).toBeVisible();
  // неизвестное значение — текущая неделя
  await page.goto('/director?week=unknown');
  await expect(page.getByTestId('week-current')).toHaveAttribute('aria-current', 'page');
});

// Дефект 7 (круг 3): «В пуле» без запаса в днях, «Подробнее» на базовой линии заголовка и на одном правом краю,
// «Причины отказа» — два списка (подписи колонок из пресета)
test('«В пуле»: только число и «готово к раздаче»', async ({ page }) => {
  await login(page, director);
  await page.goto('/director');
  const pool = page.getByRole('region', { name: 'Показатели недели' }).locator('.k-stat').filter({ hasText: 'В пуле' });
  await expect(pool).toContainText('готово к раздаче');
  await expect(pool).not.toContainText('хватит');
  await expect(pool).not.toContainText('дн.');
});

test.describe('ноутбук 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('«Подробнее» на базовой линии своего заголовка, правый край у всех блоков один; причины — два списка рядом', async ({ page }) => {
    await login(page, director);
    await page.goto('/director');
    await expect(page.getByTestId('director-reasons-trash')).toBeVisible();
    const blocks = page.getByTestId('director-block');
    expect(await blocks.count()).toBeGreaterThanOrEqual(4);
    const geo = await blocks.evaluateAll((list) =>
      list.map((b) => {
        const baseline = (el: Element): number => {
          const probe = document.createElement('span');
          probe.style.cssText = 'display:inline-block;width:0;height:0';
          el.appendChild(probe);
          const y = probe.getBoundingClientRect().bottom;
          probe.remove();
          return y;
        };
        const h = b.querySelector('h2')!;
        const link = b.querySelector('[data-testid="director-more"]')!;
        const r = document.createRange();
        r.selectNodeContents(link);
        return { dy: Math.abs(baseline(h) - baseline(link.querySelector('span')!)), right: r.getBoundingClientRect().right, last: link.parentElement!.lastElementChild === link };
      }),
    );
    for (const g of geo) {
      expect(g.dy, 'базовая линия заголовка и «Подробнее»').toBeLessThanOrEqual(1);
      expect(g.last, '«Подробнее» — последнее действие шапки').toBe(true);
    }
    for (const g of geo) expect(Math.abs(g.right - geo[0]!.right), 'правый край «Подробнее»').toBeLessThanOrEqual(1);
    // два списка причин рядом: общая верхняя граница, колонка «перезвон» правее
    const trash = await page.getByTestId('director-reasons-trash').boundingBox();
    const callback = await page.getByTestId('director-reasons-callback').boundingBox();
    expect(Math.abs(trash!.y - callback!.y)).toBeLessThanOrEqual(1);
    expect(callback!.x).toBeGreaterThan(trash!.x + trash!.width - 1);
    await expect(page.getByTestId('director-reasons-trash').getByRole('heading', { level: 3 })).toContainText('Мусор');
    await expect(page.getByTestId('director-reasons-callback').getByRole('heading', { level: 3 })).toContainText('Перезвон');
    await expect(page.getByTestId('director-reasons-note-callback')).toBeVisible();
  });
});

test('телефон: списки причин друг под другом', async ({ page }) => {
  test.skip(test.info().project.name !== 'pixel-7', 'геометрия проверяется на Pixel 7');
  await login(page, director);
  await page.goto('/director');
  const trash = await page.getByTestId('director-reasons-trash').boundingBox();
  const callback = await page.getByTestId('director-reasons-callback').boundingBox();
  expect(callback!.y).toBeGreaterThanOrEqual(trash!.y + trash!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
