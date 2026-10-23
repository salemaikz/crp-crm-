// Доска оператора (pipeline-v2 §9, линия U1): перенос мышью на ноутбуке, «Перенести в…» на телефоне, офлайн-перенос,
// поиск только по своим, звонок с плитки, шторка лида, оболочка без сети. Нужна БД e2e (E2E_DATABASE_URL) и сервер,
// запущенный с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд; в бою флаги выключены).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, callsOf, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1' || process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд)');

test.beforeAll(() => {
  prepareDb();
});

const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });
const columnOf = (page: Page, key: string) => page.getByTestId(`column-${key}`);

async function openBoard(page: Page, op: Operator): Promise<void> {
  await login(page, op);
  await page.goto('/board');
  await expect(page.getByTestId('board-screen')).toBeVisible();
  await expect(page.getByTestId('lead-tile').first()).toBeVisible();
}

test.describe('ноутбук', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('перенос мышью в «Перезвон»: причина и срок без времени, итог уходит с каналом board', async ({ page }) => {
    const op = await makeOperator(2);
    await openBoard(page, op);
    // Шесть колонок в ряд: «Новые» и «Перезвон» видны сразу
    await expect(columnOf(page, 'new')).toBeVisible();
    const tile = tileOf(page, op.names[0]!);
    const from = await tile.getByTestId('tile-open').boundingBox();
    const to = await columnOf(page, 'callback').boundingBox();
    expect(from && to).toBeTruthy();
    await page.mouse.move(from!.x + 10, from!.y + 10);
    await page.mouse.down();
    await page.mouse.move(from!.x + 60, from!.y + 20, { steps: 4 });
    await page.mouse.move(to!.x + to!.width / 2, to!.y + 80, { steps: 12 });
    // Над колонкой-целью видна подсветка и «призрак» плитки
    await expect(columnOf(page, 'callback')).toHaveAttribute('data-drop', 'ok');
    await expect(page.getByTestId('drag-ghost')).toContainText(op.names[0]!);
    await page.mouse.up();

    const sheet = page.getByTestId('outcome-sheet');
    await expect(sheet).toBeVisible();
    // В окне только «Перезвонить» и «Не берёт»
    await expect(page.getByTestId('outcome-callback')).toBeVisible();
    await expect(page.getByTestId('outcome-no_answer')).toBeVisible();
    await expect(page.getByTestId('outcome-agreed')).toHaveCount(0);
    await expect(page.getByTestId('outcome-do_not_call')).toHaveCount(0);

    await page.getByTestId('lpr-yes').click();
    await page.getByTestId('outcome-callback').click();
    const details = page.getByTestId('outcome-details');
    await details.getByRole('button', { name: 'Подумает' }).click();
    const hint = page.getByTestId('callback-hint');
    await hint.click();
    await expect(page.getByTestId('callback-chosen')).toContainText('в течение дня');
    await page.getByTestId('sheet-save').click();
    await expect(sheet).toBeHidden();

    // Плитка сразу переехала и ждёт отправки
    const moved = columnOf(page, 'callback').getByTestId('lead-tile').filter({ hasText: op.names[0]! });
    await expect(moved).toBeVisible();
    await expect(columnOf(page, 'new').getByText(op.names[0]!)).toHaveCount(0);

    await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
    const [row] = await sql<{ state: string; precision: string; reason: string }[]>`
      SELECT state, next_call_precision AS precision, callback_reason AS reason FROM cards WHERE id = ${op.cardIds[0]!}`;
    expect(row).toEqual({ state: 'callback', precision: 'day', reason: 'think' });
    expect((await callsOf(op.id))[0]!.via).toBe('board');
    // Вторая плитка не тронута
    await expect(columnOf(page, 'new').getByText(op.names[1]!)).toBeVisible();
  });

  test('перетаскивание в запрещённую колонку ничего не делает; клик по плитке открывает шторку лида', async ({ page }) => {
    const op = await makeOperator(1);
    await openBoard(page, op);
    const from = await tileOf(page, op.names[0]!).getByTestId('tile-open').boundingBox();
    const to = await columnOf(page, 'purchase').boundingBox();
    await page.mouse.move(from!.x + 10, from!.y + 10);
    await page.mouse.down();
    await page.mouse.move(from!.x + 50, from!.y + 20, { steps: 3 });
    await expect(columnOf(page, 'purchase')).toHaveAttribute('data-drop', 'no');
    await page.mouse.move(to!.x + 40, to!.y + 80, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('outcome-sheet')).toHaveCount(0);
    await expect(page.getByTestId('trash-sheet')).toHaveCount(0);
    await expect(columnOf(page, 'new').getByText(op.names[0]!)).toBeVisible();

    // Обычный клик (без сдвига) — шторка лида с кнопкой «Открыть карточку»
    await tileOf(page, op.names[0]!).getByTestId('tile-open').click();
    await expect(page.getByTestId('lead-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-open-card')).toHaveAttribute('href', `/clients/${op.clientIds[0]!}`);
  });
});

test('телефон: «⋯ → Перенести в…» в «Мусор» с причиной; итог уходит и плитка не возвращается', async ({ page }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  // Колонки — вкладки с числами, под ними одна колонка
  await expect(page.getByTestId('column-tabs')).toBeVisible();
  await expect(page.getByTestId('tab-trash')).toBeVisible();
  const tile = tileOf(page, op.names[0]!);
  await tile.getByTestId('tile-menu').click();
  const menu = page.getByTestId('move-menu');
  await expect(menu).toBeVisible();
  // «Договорились», «Покупка» до этапа В недоступны и показаны погашенными
  await expect(menu.getByTestId('move-to-purchase')).toBeDisabled();
  await menu.getByTestId('move-to-trash').click();

  const sheet = page.getByTestId('trash-sheet');
  await expect(sheet).toBeVisible();
  // «Не отвечает» при нулевых попытках погашено подсказкой «сначала позвоните»
  await expect(page.getByTestId('trash-reason-written_off-unreachable')).toBeDisabled();
  await expect(page.getByTestId('trash-call-first')).toBeVisible();
  await page.getByTestId('trash-reason-not_interested-no_need').click();
  // «ЛПР: да / нет» спрашивается, если настройки требуют его для этого итога
  if (await page.getByTestId('trash-lpr-yes').count()) await page.getByTestId('trash-lpr-yes').click();
  await page.getByTestId('trash-confirm').click();
  await expect(sheet).toBeHidden();
  await expect(columnOf(page, 'new').getByText(op.names[0]!)).toHaveCount(0);

  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  const [row] = await sql<{ state: string; reason: string }[]>`SELECT state, close_reason_code AS reason FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(row).toEqual({ state: 'not_interested', reason: 'no_need' });
  expect((await callsOf(op.id))[0]!.via).toBe('board');
  // Вторая плитка осталась
  await expect(columnOf(page, 'new').getByText(op.names[1]!)).toBeVisible();
});

test('телефон: перенос без сети уходит после восстановления сети, один раз', async ({ page, context }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  await context.setOffline(true);
  await tileOf(page, op.names[0]!).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  // «Не берёт» — одним нажатием
  await page.getByTestId('outcome-no_answer').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 1', { timeout: 15_000 });
  expect(await callsOf(op.id)).toHaveLength(0);
  // Плитка с итогом в очереди устройства заблокирована
  await expect(tileOf(page, op.names[0]!).getByTestId('tile-waiting')).toBeVisible();

  await context.setOffline(false);
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
  await expect(page.getByTestId('outbox-banner')).toBeHidden({ timeout: 20_000 });
  const [row] = await sql<{ state: string; attempts: number }[]>`SELECT state, attempts FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(row).toEqual({ state: 'retry', attempts: 1 });
  await page.waitForTimeout(1_500);
  expect(await callsOf(op.id)).toHaveLength(1);
});

test('поиск находит свою карточку и не находит чужую', async ({ page }) => {
  const mine = await makeOperator(2);
  const other = await makeOperator(2);
  // Метка прогона из названия «ТОО Синтетика <метка> №1»: запрос по названию с меткой
  const tagOf = (names: string[]) => names[0]!.split(' ')[2]!;
  await openBoard(page, mine);
  const search = page.getByTestId('board-search');
  await search.fill(`Синтетика ${tagOf(mine.names)}`);
  await expect(page.getByTestId('search-match')).toHaveCount(2);
  await expect(page.getByTestId('search-match').first()).toContainText(`Синтетика ${tagOf(mine.names)}`);
  const ids = await page.getByTestId('search-match').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')));
  expect(ids.sort()).toEqual([...mine.cardIds].sort());
  // Найденные плитки подсвечены на доске
  await expect(tileOf(page, mine.names[1]!)).toHaveAttribute('data-card-id', mine.cardIds[1]!);

  await search.fill(`Синтетика ${tagOf(other.names)}`);
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await expect(page.getByTestId('search-match')).toHaveCount(0);
  // Чужого названия нет ни в списке совпадений, ни на доске
  await expect(page.getByText(other.names[0]!)).toHaveCount(0);

  await search.fill('аб');
  await expect(page.getByTestId('search-short')).toBeVisible();
});

test('«Позвонить» на плитке пишет намерение звонка: шторка итога открывается, итог уходит с каналом ui', async ({ page }) => {
  const op = await makeOperator(1);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-call').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible({ timeout: 10_000 });
  // В шторке после звонка доступны все виды итога, не только «Перезвон»
  await expect(page.getByTestId('outcome-agreed')).toBeVisible();
  await page.getByTestId('outcome-no_answer').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  expect((await callsOf(op.id))[0]!.via).toBe('ui');
});

test('незавершённый звонок A: «Позвонить» у B погашено, намерение A не теряется и уходит итогом', async ({ page }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-call').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible({ timeout: 10_000 });
  // Шторку закрыли, итог не внесён: висит баннер, у другой плитки звонок погашен, у своей рабочий
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('call-pending-banner')).toBeVisible();
  await expect(tileOf(page, op.names[1]!).getByTestId('tile-call')).toBeDisabled();
  await expect(tileOf(page, op.names[0]!).getByTestId('tile-call')).toBeEnabled();
  await page.getByTestId('call-resume').click();
  await page.getByTestId('outcome-no_answer').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  // После итога B снова доступна
  await expect(tileOf(page, op.names[1]!).getByTestId('tile-call')).toBeEnabled();
});

test('перенос при висящем звонке: итог один, баннер и блокировка «Позвонить» снимаются', async ({ page }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-call').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('call-pending-banner')).toBeVisible();
  // «⋯ → Перенести в… → Мусор → Не интересует» на той же плитке тратит намерение звонка
  await tileOf(page, op.names[0]!).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-trash').click();
  await page.getByTestId('trash-reason-not_interested-no_need').click();
  if (await page.getByTestId('trash-lpr-yes').count()) await page.getByTestId('trash-lpr-yes').click();
  await page.getByTestId('trash-confirm').click();
  await expect(page.getByTestId('trash-sheet')).toBeHidden();
  await expect(page.getByTestId('call-pending-banner')).toHaveCount(0);
  await expect(tileOf(page, op.names[1]!).getByTestId('tile-call')).toBeEnabled();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  expect((await callsOf(op.id))[0]!.via).toBe('ui');
});

test('«Отменить» итога звонка с плитки возвращает шторку: «Позвонить» на другой плитке погашено', async ({ page }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-call').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('outcome-no_answer').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('call-pending-banner')).toBeVisible();
  await expect(tileOf(page, op.names[1]!).getByTestId('tile-call')).toBeDisabled();
});

test('без сети /board открывает оболочку с «Нет сети», «Звонить подряд» на месте', async ({ page, context }) => {
  const op = await makeOperator(1);
  await openBoard(page, op);
  // Service worker берёт управление и кладёт оболочку в кэш при следующем заходе
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.goto('/board');
  await expect(page.getByTestId('lead-tile').first()).toBeVisible();
  await page.waitForFunction(async () => (await caches.keys()).includes('crm-shell-v4') && !!(await (await caches.open('crm-shell-v4')).match('/board')));

  await context.setOffline(true);
  await page.goto('/board');
  await expect(page.getByText('Нет сети', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('offline-call-next')).toBeVisible();
  // Данные доски на телефоне не копятся: ни названия клиента, ни номера в странице нет
  await expect(page.getByText(op.names[0]!)).toHaveCount(0);
  await context.setOffline(false);
});

test('доска читается в светлой и тёмной теме: плитка и колонка следуют теме, снимки обеих тем', async ({ page }, testInfo) => {
  test.skip(process.env.FEATURE_THEME_DARK === '0', 'тёмная тема выключена флагом');
  // Тон «был на встрече»: у плитки признак, цвет из пресета (зелёный) и текст-значок вместе
  const op = await makeOperator(2);
  await sql`UPDATE cards SET attended_group_at = ${Date.now() - 86_400_000} WHERE id = ${op.cardIds[0]!}`;
  await page.emulateMedia({ colorScheme: 'light' });
  await openBoard(page, op);
  const tile = tileOf(page, op.names[0]!);
  await expect(tile).toHaveAttribute('data-tone', 'success');
  await expect(tile.getByTestId('tile-badge-attendedGroup')).toBeVisible();
  const light = await tile.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
  await testInfo.attach('board-light', { body: await page.screenshot(), contentType: 'image/png' });

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => tile.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(light.bg);
  const dark = await tile.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
  expect(dark.text).not.toBe(light.text);
  // Обычная плитка без признака: фон поверхности тёмный, не белый
  const plain = await tileOf(page, op.names[1]!).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(plain).not.toBe('rgb(255, 255, 255)');
  await testInfo.attach('board-dark', { body: await page.screenshot(), contentType: 'image/png' });
});
