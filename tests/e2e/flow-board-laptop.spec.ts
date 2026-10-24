// Доска на ноутбуке в светлой и тёмной теме (pipeline-v2 §17, линия Q1): шесть колонок в ряд, огонёк просроченного
// перезвона, плитка «Договорились», итог покупок и экран «Мои покупки», доска РОП с фильтром сотрудника. Тема берётся
// из системы (ВП-12), поэтому схема задаётся контексту браузера. Нужна БД e2e и сервер с FEATURE_OP_BOARD=1,
// FEATURE_CALLBACK_V2=1 и FEATURE_THEME_DARK=1 (стенд). Синтетика: +7 709 …, «ТОО Синтетика …».
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, login, makeOperator, prepareDb, sql } from './support/calling';
import { makeAgreed, makeWonDeal } from './support/board';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1' || process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд)');
test.skip(process.env.FEATURE_THEME_DARK === '0', 'тёмная тема выключена флагом');

test.beforeAll(() => prepareDb());

const DAY = 86_400_000;
const COLUMNS = ['new', 'callback', 'br', 'bk', 'purchase', 'trash'];
const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const colors = (page: Page, name: string) =>
  tileOf(page, name).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`ноутбук, ${scheme === 'light' ? 'светлая' : 'тёмная'} тема`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: scheme });

    test('оператор: все колонки в ряд, огонёк, «Договорились», покупки; экран читается и не ломает вёрстку', async ({ page }, testInfo) => {
      const op = await makeOperator(2);
      const [agreed] = await makeAgreed(op, 1);
      const won = await makeWonDeal(op.id, 150000);
      // Вторая карточка — перезвон, срок которого прошёл вчера (огонёк «просрочен»)
      await sql`UPDATE cards SET state = 'callback', callback_reason = 'think', callback_touches = 1, next_call_precision = 'day', next_call_at = ${Date.now() - 2 * DAY} WHERE id = ${op.cardIds[1]!}`;

      await login(page, op);
      await page.goto('/board');
      await expect(page.getByTestId('board-screen')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
      expect(await page.evaluate((sc) => matchMedia(`(prefers-color-scheme: ${sc})`).matches, scheme)).toBe(true);
      for (const key of COLUMNS) await expect(page.getByTestId(`column-${key}`)).toBeVisible();
      expect(await noHScroll(page)).toBe(true);

      const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const fresh = await colors(page, op.names[0]!);
      // Плитка отличима от фона и читается: цвет текста не равен цвету плитки
      expect(fresh.bg).not.toBe(fresh.text);
      if (scheme === 'dark') expect(fresh.bg).not.toBe('rgb(255, 255, 255)');
      else expect(canvas).not.toBe(fresh.text);

      const overdue = tileOf(page, op.names[1]!);
      await expect(overdue.getByTestId('tile-fire')).toContainText('Перезвон просрочен');
      await expect(tileOf(page, agreed!.name)).toBeVisible();
      await expect(page.getByTestId('purchases-month')).toContainText('150');
      await testInfo.attach(`board-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });

      await page.getByTestId('purchases-link').click();
      await page.waitForURL('**/board/purchases');
      await expect(page.getByTestId('purchases-list').getByText(won.name)).toBeVisible();
      expect(await noHScroll(page)).toBe(true);
      const row = await page.getByTestId('purchases-list').evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
      expect(row.text).not.toBe(row.bg);
      await testInfo.attach(`purchases-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });
    });

    test('РОП: доска с фильтром сотрудника на ноутбуке', async ({ page }, testInfo) => {
      const rop = await makeOperator(0, { role: 'rop' });
      await sql`UPDATE users SET name = ${'РОП Синтетик ' + rop.id.slice(0, 4)} WHERE id = ${rop.id}`;
      const op = await makeOperator(2);
      await login(page, rop);
      await page.goto('/deals/calling');
      await expect(page.getByTestId('board-manager-filters')).toBeVisible();
      await page.getByTestId('filter-owner').selectOption(op.id);
      await expect(tileOf(page, op.names[0]!)).toBeVisible();
      expect(await noHScroll(page)).toBe(true);
      await testInfo.attach(`rop-board-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  });
}

// Геометрия ряда колонок (ui-polish §9.2, B2): каждая колонка целиком в ряду и в окне, высота до низа окна, своя прокрутка.
const rightEdge = async (page: Page) => {
  const row = await page.getByTestId('board-columns').boundingBox();
  const inner = await page.evaluate(() => window.innerWidth);
  const out: Record<string, number> = {};
  for (const key of COLUMNS) {
    const b = await page.getByTestId(`column-${key}`).boundingBox();
    out[key] = b ? b.x + b.width : Infinity;
  }
  return { rowRight: row ? row.x + row.width : 0, inner, out };
};

test.describe('геометрия колонок на ноутбуке', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  for (const who of ['operator', 'rop'] as const) {
    test(`1440×900, ${who}: правый край каждой колонки не дальше края ряда и окна`, async ({ page }) => {
      const op = await makeOperator(8, who === 'rop' ? { role: 'rop' } : {});
      await login(page, op);
      await page.goto(who === 'rop' ? '/deals/calling' : '/board');
      await expect(page.getByTestId('board-screen')).toBeVisible();
      const g = await rightEdge(page);
      for (const key of COLUMNS) {
        expect(g.out[key]!, `колонка ${key}`).toBeLessThanOrEqual(g.rowRight + 0.5);
        expect(g.out[key]!, `колонка ${key}`).toBeLessThanOrEqual(g.inner + 0.5);
      }
      expect(await noHScroll(page)).toBe(true);
    });
  }

  test('после прокрутки «Новых» на 600 px шапки всех колонок видны', async ({ page }) => {
    const op = await makeOperator(20);
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('board-screen')).toBeVisible();
    await page.getByTestId('column-new').evaluate((el) => (el.scrollTop = 600));
    await page.waitForTimeout(200);
    for (const key of COLUMNS) {
      const h = await page.getByTestId(`column-header-${key}`).boundingBox();
      expect(h, key).not.toBeNull();
      expect(h!.y).toBeGreaterThanOrEqual(0);
      expect(h!.y + h!.height).toBeLessThanOrEqual(900);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('ряд колонок на 1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('ряд целиком в окне по вертикали, у документа нет горизонтальной прокрутки', async ({ page }) => {
    const op = await makeOperator(20);
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('board-screen')).toBeVisible();
    const row = await page.getByTestId('board-columns').boundingBox();
    expect(row!.y + row!.height).toBeLessThanOrEqual(800 + 0.5);
    expect(await noHScroll(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  });
});

// Плотность плитки на ноутбуке (ui-polish §9.3, B6): в «Новых» видно не меньше шести плиток, плитка не выше 100 px
test.describe('плотность на 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('«Новые»: не меньше шести плиток целиком, медианная высота ≤ 100 px, «Позвонить» круглая в первой строке, четвёртой строки нет', async ({ page }) => {
    const op = await makeOperator(9);
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('board-screen')).toBeVisible();
    await expect(page.getByTestId('lead-tile').first()).toBeVisible();
    const m = await page.evaluate(() => {
      const col = document.querySelector('[data-column-key="new"]')!.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('[data-column-key="new"] [data-testid="lead-tile"]')].map((el) => el.getBoundingClientRect());
      const head = document.querySelector('[data-testid="column-header-new"]')!.getBoundingClientRect();
      const heights = tiles.map((r) => r.height).sort((a, b) => a - b);
      return { whole: tiles.filter((r) => r.top >= head.bottom - 1 && r.bottom <= col.bottom + 1).length, median: heights[Math.floor(heights.length / 2)]! };
    });
    expect(m.whole).toBeGreaterThanOrEqual(6);
    expect(m.median).toBeLessThanOrEqual(100);
    const call = tileOf(page, op.names[0]!).getByTestId('tile-call');
    const box = (await call.boundingBox())!;
    const tileBox = (await tileOf(page, op.names[0]!).boundingBox())!;
    expect(Math.round(box.width)).toBe(36);
    expect(box.y - tileBox.y).toBeLessThan(20);
    await expect(tileOf(page, op.names[0]!).getByTestId('tile-whatsapp')).toBeHidden();
  });
});

// Отпустили плитку на запрещённой колонке мышью: тост с причиной (ui-polish §9.3, B8)
test.describe('перенос мышью на 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('«Покупка» и запись — запрещённые цели: тост называет причину, плитка остаётся', async ({ page }) => {
    const op = await makeOperator(2);
    await login(page, op);
    await page.goto('/board');
    const from = (await tileOf(page, op.names[0]!).getByTestId('tile-open').boundingBox())!;
    for (const [col, text] of [['purchase', 'Покупку вносит консультант или РОП'], ['br', 'Запись — через звонок']] as const) {
      const to = (await page.getByTestId(`column-${col}`).boundingBox())!;
      await page.mouse.move(from.x + 10, from.y + 10);
      await page.mouse.down();
      await page.mouse.move(from.x + 60, from.y + 20, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 12 });
      await page.mouse.up();
      await expect(page.getByText(text).first()).toBeVisible();
      await expect(page.getByTestId('column-new').getByText(op.names[0]!)).toBeVisible();
    }
  });
});
