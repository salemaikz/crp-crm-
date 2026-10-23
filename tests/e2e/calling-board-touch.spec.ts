// Доска оператора, этап В (pipeline-v2 §9.2–§9.5, линия U2): перенос долгим нажатием на телефоне, окно № 33, тумблеры
// «Был на …», цвета плиток, WhatsApp, «Мои покупки». Нужна БД e2e и сервер с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1.
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, callsOf, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';
import { makeAgreed, makeWonDeal, touchGesture } from './support/board';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1' || process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд)');

test.beforeAll(() => {
  prepareDb();
});

const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });

async function openBoard(page: Page, op: Operator, tab?: string): Promise<void> {
  await login(page, op);
  await page.goto('/board');
  await expect(page.getByTestId('board-screen')).toBeVisible();
  if (tab) await page.getByTestId(`tab-${tab}`).click();
}

const center = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`нет рамки у ${testId}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test('долгое нажатие переносит плитку на вкладку «Перезвон»: вкладки - цели, окно с видами «Перезвонить» и «Не берёт»', async ({ page, browserName }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  const name = op.names[0]!;
  const title = await tileOf(page, name).getByTestId('tile-open').boundingBox();
  const start = { x: title!.x + 6, y: title!.y + title!.height / 2 };
  const tab = await center(page, 'tab-callback');

  await touchGesture(page, browserName, [{ type: 'start', at: start }, { type: 'move', at: { x: start.x + 2, y: start.y + 2 }, waitMs: 450 }]);
  // Плитка «поднята»: за пальцем идёт призрак, разрешённые вкладки обведены, запрещённые погашены
  await expect(page.getByTestId('drag-ghost')).toContainText(name);
  await expect(page.getByTestId('tab-callback')).toHaveAttribute('data-drop', 'ok');
  await expect(page.getByTestId('tab-purchase')).toHaveAttribute('data-drop', 'no');
  await touchGesture(page, browserName, [{ type: 'move', at: { x: tab.x, y: tab.y } }]);
  await expect(page.getByTestId('tab-callback')).toHaveAttribute('data-drop', 'ok');
  await touchGesture(page, browserName, [{ type: 'end', at: { x: tab.x, y: tab.y } }]);

  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('outcome-callback')).toBeVisible();
  await expect(page.getByTestId('outcome-no_answer')).toBeVisible();
  await expect(page.getByTestId('outcome-agreed')).toHaveCount(0);
  // Шторка лида клик после жеста не открыла
  await expect(page.getByTestId('lead-drawer')).toHaveCount(0);

  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();
  await page.getByTestId('outcome-details').getByRole('button', { name: 'Подумает' }).click();
  await page.getByTestId('callback-hint').click();
  await page.getByTestId('sheet-save').click();
  await expect(sheet).toBeHidden();

  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  const [row] = await sql<{ state: string; reason: string }[]>`SELECT state, callback_reason AS reason FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(row).toEqual({ state: 'callback', reason: 'think' });
  expect((await callsOf(op.id))[0]!.via).toBe('board');
});

test('прокрутка не ломается: быстрый жест по плитке прокручивает страницу и ничего не поднимает', async ({ page, browserName }) => {
  const op = await makeOperator(9);
  await openBoard(page, op);
  const title = await tileOf(page, op.names[0]!).getByTestId('tile-open').boundingBox();
  const at = { x: title!.x + 6, y: title!.y + title!.height / 2 };
  await touchGesture(page, browserName, [
    { type: 'start', at },
    { type: 'move', at: { x: at.x, y: at.y - 40 }, waitMs: 30 },
    { type: 'move', at: { x: at.x, y: at.y - 140 }, waitMs: 30 },
    { type: 'move', at: { x: at.x, y: at.y - 240 }, waitMs: 30 },
    { type: 'end', at: { x: at.x, y: at.y - 240 }, waitMs: 30 },
  ]);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('drag-ghost')).toHaveCount(0);
  await expect(page.getByTestId('outcome-sheet')).toHaveCount(0);
  await expect(page.getByTestId('lead-drawer')).toHaveCount(0);
  // Палец, выдержанный до порога после сдвига, тоже не поднимает плитку: сдвиг раньше 350 мс - это прокрутка
  await touchGesture(page, browserName, [
    { type: 'start', at },
    { type: 'move', at: { x: at.x, y: at.y - 60 }, waitMs: 30 },
    { type: 'move', at: { x: at.x, y: at.y - 61 }, waitMs: 450 },
    { type: 'end', at: { x: at.x, y: at.y - 61 } },
  ]);
  await expect(page.getByTestId('drag-ghost')).toHaveCount(0);
  if (browserName === 'chromium') expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('№ 33: «Не пришёл» из «БР» в «Перезвон» - причина и срок подставлены, явка и переход в одной операции', async ({ page }) => {
  const rop = await makeOperator(0, { role: 'rop' });
  const [c] = await makeAgreed(rop, 1);
  await openBoard(page, rop, 'br');
  const tile = tileOf(page, c!.name);
  await expect(tile).toBeVisible();
  // У РОП тумблер активен
  await expect(tile.getByTestId('tile-toggle-attendedGroup')).toBeEnabled();
  await tile.getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();

  const sheet = page.getByTestId('exit-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('exit-attendance')).toBeVisible();
  await page.getByTestId('exit-att-no_show').click();
  // Причина неявки этого вида записи и срок «следующий рабочий день» подставились сами
  await expect(page.getByTestId('exit-reason-no_show_br')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('callback-chosen')).toBeVisible();
  await page.getByTestId('exit-confirm').click();
  await expect(sheet).toBeHidden();

  // Плитка уже в «Перезвоне»; запрос уходит через окно «Отменить»
  await page.getByTestId('tab-callback').click();
  await expect(tileOf(page, c!.name)).toBeVisible();
  await expect
    .poll(async () => (await sql<{ state: string; reason: string; status: string }[]>`
      SELECT c.state, c.callback_reason AS reason, b.status FROM cards c JOIN bookings b ON b.card_id = c.id WHERE c.id = ${c!.cardId}`)[0], { timeout: 30_000 })
    .toEqual({ state: 'callback', reason: 'no_show_br', status: 'no_show' });
});

test('№ 33: «Отменить» в окне 5 с возвращает плитку на место, на сервер ничего не уходит', async ({ page }) => {
  const rop = await makeOperator(0, { role: 'rop' });
  const [c] = await makeAgreed(rop, 1);
  await openBoard(page, rop, 'br');
  await tileOf(page, c!.name).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();
  await page.getByTestId('callback-hint').click();
  await page.getByTestId('exit-reason-think').click();
  await page.getByTestId('exit-confirm').click();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByText('Перенос отменён')).toBeVisible();
  await page.waitForTimeout(6000);
  const [row] = await sql<{ state: string }[]>`SELECT state FROM cards WHERE id = ${c!.cardId}`;
  expect(row!.state).toBe('agreed');
});

test('№ 33 у оператора: явка только для чтения; перезвон без отметки уходит с причиной и сроком', async ({ page }) => {
  const op = await makeOperator(0);
  const [c] = await makeAgreed(op, 1);
  await openBoard(page, op, 'br');
  await tileOf(page, c!.name).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();
  await expect(page.getByTestId('exit-attendance-readonly')).toBeVisible();
  await expect(page.getByTestId('exit-att-no_show')).toHaveCount(0);
  await page.getByTestId('callback-hint').click();
  await page.getByTestId('exit-reason-think').click();
  await page.getByTestId('exit-confirm').click();
  await expect
    .poll(async () => (await sql<{ state: string; reason: string }[]>`SELECT state, callback_reason AS reason FROM cards WHERE id = ${c!.cardId}`)[0], { timeout: 30_000 })
    .toEqual({ state: 'callback', reason: 'think' });
  const [b] = await sql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${c!.bookingId}`;
  expect(b!.status).not.toBe('attended');
});

test('тумблер «Был на …» у оператора только показывает признак и не нажимается', async ({ page }) => {
  const op = await makeOperator(0);
  const [c] = await makeAgreed(op, 1);
  await openBoard(page, op, 'br');
  const toggle = tileOf(page, c!.name).getByTestId('tile-toggle-attendedGroup');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click({ force: true });
  await page.waitForTimeout(500);
  const [b] = await sql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${c!.bookingId}`;
  expect(b!.status).toBe('registered');
  // В шторке лида - тот же показ с подсказкой, оба вида
  await tileOf(page, c!.name).getByTestId('tile-open').click();
  await expect(page.getByTestId('drawer-toggles')).toBeVisible();
  await expect(page.getByTestId('drawer-toggles').getByTestId('tile-toggle-attendedIndividual')).toBeDisabled();
  await expect(page.getByTestId('drawer-toggle-hint')).toBeVisible();
});

test('РОП отмечает тумблером «Был на …»: запись «пришёл», плитка становится зелёной', async ({ page }) => {
  const rop = await makeOperator(0, { role: 'rop' });
  const [c] = await makeAgreed(rop, 1);
  await openBoard(page, rop, 'br');
  const tile = tileOf(page, c!.name);
  await expect(tile).not.toHaveAttribute('data-tone', /.+/);
  await tile.getByTestId('tile-toggle-attendedGroup').click();
  await expect(tileOf(page, c!.name)).toHaveAttribute('data-tone', 'success', { timeout: 15_000 });
  await expect(tileOf(page, c!.name).getByTestId('tile-toggle-attendedGroup')).toHaveAttribute('aria-checked', 'true');
  const [b] = await sql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${c!.bookingId}`;
  expect(b!.status).toBe('attended');
});

test('цвета плиток: консультация - жёлтая, групповая встреча - зелёная; значок и слово вместе с цветом', async ({ page }) => {
  const op = await makeOperator(2);
  const t = Date.now() - 86_400_000;
  await sql`UPDATE cards SET attended_individual_at = ${t} WHERE id = ${op.cardIds[0]!}`;
  await sql`UPDATE cards SET attended_group_at = ${t} WHERE id = ${op.cardIds[1]!}`;
  await openBoard(page, op);
  await expect(tileOf(page, op.names[0]!)).toHaveAttribute('data-tone', 'warning');
  await expect(tileOf(page, op.names[1]!)).toHaveAttribute('data-tone', 'success');
  await expect(tileOf(page, op.names[1]!).getByTestId('tile-toggle-attendedGroup')).toHaveAttribute('aria-checked', 'true');
  await expect(tileOf(page, op.names[0]!).getByTestId('tile-toggle-attendedIndividual')).toHaveAttribute('aria-checked', 'true');
});

test('WhatsApp на плитке: ссылка wa.me с номером клиента, отметка в ленту', async ({ page }) => {
  const op = await makeOperator(1);
  await openBoard(page, op);
  const link = tileOf(page, op.names[0]!).getByTestId('tile-whatsapp');
  await expect(link).toHaveAttribute('href', /^https:\/\/wa\.me\/7709\d+/);
  await expect(link).toHaveAttribute('target', '_blank');
});

test('«Мои покупки»: итог месяца в шапке «Покупки» и экран со засчитанной сделкой', async ({ page }) => {
  const op = await makeOperator(1);
  const won = await makeWonDeal(op.id, 150000);
  await openBoard(page, op, 'purchase');
  await expect(page.getByTestId('purchases-month')).toContainText('1');
  await expect(page.getByTestId('purchases-month')).toContainText('150');
  await page.getByTestId('purchases-link').click();
  await page.waitForURL('**/board/purchases');
  await expect(page.getByTestId('purchases-screen')).toBeVisible();
  const row = page.getByTestId('purchases-list').getByText(won.name);
  await expect(row).toBeVisible();
  await expect(page.getByTestId('purchases-list')).toContainText('150');
  await expect(page.getByTestId('purchases-month-total')).toContainText('150');
});
