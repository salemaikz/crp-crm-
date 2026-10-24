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
