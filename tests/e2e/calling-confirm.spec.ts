// Обзвон «подтвердить явку» на доске (D-355, round3 §1, линия board B7): плитка обзвона сверху колонки записи, звонок →
// шторка ответа → «Придёт» / «Не придёт» / «Не дозвонился», офлайн, доска РОП. Нужна БД e2e и сервер с FEATURE_OP_BOARD=1 и
// FEATURE_CALLBACK_V2=1. День обзвона — наложением настроек сида (weekdays = [1..7]); код времени не подменяется.
// Мероприятие стартует через 30 минут (в пределах местных суток): прогон близко к местной полуночи неприменим.
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, callsOf, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';
import { makeAgreed } from './support/board';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 (стенд)');

test.beforeAll(() => {
  prepareDb();
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/support/confirm-day.ts'], { stdio: 'inherit', env: { ...process.env } });
});

const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });
const SOON = -30 * 60_000;

async function open(page: Page, op: Operator, path = '/board'): Promise<void> {
  await login(page, op);
  await page.goto(path);
  await expect(page.getByTestId('board-screen')).toBeVisible();
  const tab = page.getByTestId('tab-br');
  if (await tab.isVisible()) await tab.click();
  await expect(page.getByTestId('column-br').getByTestId('lead-tile').first()).toBeVisible();
}

const bookingOf = async (id: string) => (await sql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${id}`)[0]!.status;

for (const [label, viewport, mobile] of [['Pixel 7', { width: 412, height: 915 }, true], ['1440', { width: 1440, height: 900 }, false]] as const) {
  test.describe(`обзвон, ${label}`, () => {
    test.use({ viewport, isMobile: mobile, hasTouch: mobile });

    test('плитка обзвона сверху; звонок → «Придёт» → «✓ Придёт», запись confirmed', async ({ page }, testInfo) => {
      const op = await makeOperator(0);
      const agreed = await makeAgreed(op, 3, { startedAgoMs: SOON });
      await open(page, op);
      const col = page.getByTestId('column-br');
      await expect(page.getByTestId('confirm-line')).toContainText('Подтвердить явку · БР');
      await expect(page.getByTestId('confirm-line')).toContainText('осталось 3');
      // Все три — «Подтвердить явку», кнопка звонка есть у плиток обзвона
      await expect(col.getByTestId('tile-confirm-todo')).toHaveCount(3);
      await expect(col.getByTestId('tile-call')).toHaveCount(3);
      await testInfo.attach('confirm-tile', { body: await page.screenshot(), contentType: 'image/png' });

      const first = tileOf(page, agreed[0]!.name);
      await first.getByTestId('tile-call').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('outcome-sheet')).toHaveCount(0);
      await testInfo.attach('confirm-sheet', { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByTestId('confirm-yes').click();
      await expect(page.getByTestId('confirm-sheet')).toBeHidden();
      await expect(first.getByTestId('tile-confirm-confirmed')).toContainText('✓ Придёт');
      await expect(first.getByTestId('tile-call')).toHaveCount(0);
      expect(await bookingOf(agreed[0]!.bookingId)).toBe('confirmed');
      await expect(page.getByTestId('confirm-line')).toContainText('осталось 2');
      // Звонка в журнале нет: «Придёт» не считается звонком
      expect(await callsOf(op.id)).toHaveLength(0);
      // Подтверждённая уходит вниз, плитки обзвона остаются сверху
      const order = await col.getByTestId('lead-tile').evaluateAll((els) => els.map((e) => e.querySelector('[data-testid^="tile-confirm-"]')?.getAttribute('data-testid')));
      expect(order.at(-1)).toBe('tile-confirm-confirmed');
    });

    test('«Не дозвонился» → плитка ниже «подтвердить», запись остаётся registered; «Другой итог…» открывает обычную шторку', async ({ page }) => {
      const op = await makeOperator(0);
      const agreed = await makeAgreed(op, 2, { startedAgoMs: SOON });
      await open(page, op);
      const a = tileOf(page, agreed[0]!.name);
      await a.getByTestId('tile-call').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('confirm-other').click();
      await expect(page.getByTestId('outcome-sheet')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByTestId('call-resume').click();
      await expect(page.getByTestId('outcome-sheet')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByTestId('call-pending-banner').getByTestId('call-resume').click();
      await page.getByTestId('outcome-no_answer').click();
      await expect(page.getByTestId('outcome-sheet')).toBeHidden();
      await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
      await expect(tileOf(page, agreed[0]!.name).getByTestId('tile-confirm-tries')).toContainText('Не дозвонился ×1', { timeout: 20_000 });
      // «Не дозвонился» (tried) стоит ниже «Подтвердить явку» (todo)
      const marks = await page.getByTestId('column-br').getByTestId('lead-tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')));
      expect(marks.at(-1)).toBe(agreed[0]!.cardId);
      expect(await bookingOf(agreed[0]!.bookingId)).toBe('registered');
    });

    test('«Не придёт»: причина из настроек, срок по касанию выбран, карточка во вкладке «Перезвон» с подписью причины', async ({ page }, testInfo) => {
      const op = await makeOperator(0);
      const agreed = await makeAgreed(op, 1, { startedAgoMs: SOON });
      await open(page, op);
      await tileOf(page, agreed[0]!.name).getByTestId('tile-call').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('confirm-no').click();
      await expect(page.getByTestId('confirm-reason')).toHaveText('Не придёт на бизнес-разбор');
      await expect(page.getByTestId('callback-hint')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('callback-with-time')).toHaveCount(0);
      await testInfo.attach('confirm-decline', { body: await page.screenshot(), contentType: 'image/png' });
      const save = page.getByTestId('confirm-decline-save');
      await expect(save).toHaveText(/^Сохранить · \S+ \d\d\.\d\d$/);
      await save.click();
      await expect(page.getByTestId('confirm-sheet')).toBeHidden();
      const [row] = await sql<{ state: string; reason: string; precision: string }[]>`SELECT state, callback_reason AS reason, next_call_precision AS precision FROM cards WHERE id = ${agreed[0]!.cardId}`;
      expect(row).toEqual({ state: 'callback', reason: 'wont_come_br', precision: 'day' });
      if (mobile) await page.getByTestId('tab-callback').click();
      const moved = page.getByTestId('column-callback').getByTestId('lead-tile').filter({ hasText: agreed[0]!.name });
      await expect(moved).toBeVisible();
      await expect(moved.getByTestId('tile-chip')).toContainText('Не придёт на бизнес-разбор');
    });

    test('«⋯»: «Придёт» без звонка подтверждает запись', async ({ page }) => {
      const op = await makeOperator(0);
      const agreed = await makeAgreed(op, 1, { startedAgoMs: SOON });
      await open(page, op);
      await tileOf(page, agreed[0]!.name).getByTestId('tile-menu').click();
      await page.getByTestId('menu-confirm-yes').click();
      await expect(tileOf(page, agreed[0]!.name).getByTestId('tile-confirm-confirmed')).toBeVisible();
      expect(await bookingOf(agreed[0]!.bookingId)).toBe('confirmed');
    });

    test('без сети «Придёт» и «Не придёт» погашены, «Не дозвонился» уходит после сети', async ({ page, context }) => {
      const op = await makeOperator(0);
      const agreed = await makeAgreed(op, 1, { startedAgoMs: SOON });
      await open(page, op);
      await tileOf(page, agreed[0]!.name).getByTestId('tile-call').click();
      await expect(page.getByTestId('confirm-sheet')).toBeVisible({ timeout: 10_000 });
      await context.setOffline(true);
      await expect(page.getByTestId('confirm-yes')).toBeDisabled();
      await expect(page.getByTestId('confirm-no')).toBeDisabled();
      await expect(page.getByTestId('confirm-offline')).toHaveText('Нужна сеть: ответ меняет запись');
      await page.getByTestId('confirm-no-answer').click();
      await expect(page.getByTestId('confirm-sheet')).toBeHidden();
      expect(await callsOf(op.id)).toHaveLength(0);
      await context.setOffline(false);
      await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
      await page.waitForTimeout(1_500);
      expect(await callsOf(op.id)).toHaveLength(1);
      expect(await bookingOf(agreed[0]!.bookingId)).toBe('registered');
    });

    test('РОП: «✓ Придёт · инициалы» и счётчик; фильтр «Подтвердить явку» открывает колонку записи', async ({ page }, testInfo) => {
      const rop = await makeOperator(0, { role: 'rop' });
      const op = await makeOperator(0);
      await sql`UPDATE users SET name = ${'Айгерим Синтетик'} WHERE id = ${op.id}`;
      const agreed = await makeAgreed(op, 2, { startedAgoMs: SOON });
      // Оператор подтверждает первую запись (по-настоящему, через интерфейс его сессии)
      const ctx = await page.context().browser()!.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'ru-RU', timezoneId: 'Asia/Almaty' });
      const opPage = await ctx.newPage();
      await open(opPage, op);
      await tileOf(opPage, agreed[0]!.name).getByTestId('tile-menu').click();
      await opPage.getByTestId('menu-confirm-yes').click();
      await expect(tileOf(opPage, agreed[0]!.name).getByTestId('tile-confirm-confirmed')).toBeVisible();
      await ctx.close();

      await open(page, rop, '/deals/calling');
      await expect(page.getByTestId('confirm-line')).toContainText('осталось');
      await expect(page.getByTestId('confirm-line')).toContainText('придут');
      const done = tileOf(page, agreed[0]!.name);
      await expect(done.getByTestId('tile-confirm-by')).toHaveText(/· АС/);
      await expect(done.getByTestId('tile-confirm-by')).toHaveAttribute('title', /Айгерим Синтетик/);
      await expect(done.getByTestId('tile-call')).toHaveCount(0);
      await testInfo.attach('rop-confirm', { body: await page.screenshot(), contentType: 'image/png' });
      if (!mobile) {
        await page.getByTestId('filter-confirm').click();
        await expect(page.getByTestId('filter-confirm')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('column-br')).toBeVisible();
      } else {
        await page.getByTestId('board-filters-open').click();
        await page.getByTestId('filter-confirm').click();
        await page.getByTestId('filters-done').click();
        await expect(page.getByTestId('tab-br')).toHaveAttribute('aria-selected', 'true');
      }
    });
  });
}

test.describe('без CALLBACK_V2 пометок обзвона нет', () => {
  test.skip(process.env.FEATURE_CALLBACK_V2 === '1', 'проверяется запуском без флага');
  test('плитка «Договорились» без пометок и без «Позвонить»', async ({ page }) => {
    const op = await makeOperator(0);
    const agreed = await makeAgreed(op, 1, { startedAgoMs: SOON });
    await login(page, op);
    await page.goto('/board');
    await expect(page.getByTestId('lead-tile').first()).toBeVisible();
    await expect(page.getByTestId('confirm-line')).toHaveCount(0);
    await expect(page.getByTestId('filter-confirm')).toHaveCount(0);
    await expect(page.getByTestId(/tile-confirm-/)).toHaveCount(0);
    void agreed;
  });
});
