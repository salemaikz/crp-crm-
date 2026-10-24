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
    // В окне переноса только «Перезвонить»: «Не берёт» — недозвон, его ставит звонок; заголовок без номера телефона
    await expect(page.getByTestId('outcome-callback')).toBeVisible();
    await expect(page.getByTestId('outcome-no_answer')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'В «Перезвон»' })).toBeVisible();
    await expect(page.getByRole('dialog')).not.toContainText('+7 709');
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
    // Отпустили на запрещённой колонке: тост называет причину, а не молчит
    await expect(page.getByText('Покупку вносит консультант или РОП')).toBeVisible();
    await expect(page.getByTestId('outcome-sheet')).toHaveCount(0);
    await expect(page.getByTestId('trash-sheet')).toHaveCount(0);
    await expect(columnOf(page, 'new').getByText(op.names[0]!)).toBeVisible();

    // Обычный клик (без сдвига) — шторка лида с кнопкой «Открыть карточку»
    await tileOf(page, op.names[0]!).getByTestId('tile-open').click();
    await expect(page.getByTestId('lead-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-open-card')).toHaveAttribute('href', `/clients/${op.clientIds[0]!}?from=board&tab=new`);
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
  // Погашенные цели названы причиной по коду: покупку вносит консультант, запись - через звонок (с кнопкой «Позвонить»)
  await expect(menu.getByTestId('move-to-purchase')).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByTestId('move-reason-purchase')).toHaveText('Покупку вносит консультант или РОП');
  await expect(menu.getByTestId('move-reason-br')).toContainText('Запись — через звонок');
  await expect(menu.getByTestId('move-reason-br')).toContainText('Договорились');
  await expect(menu.getByTestId('move-call').first()).toBeVisible();
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
  // «Перезвонить» с причиной; срок по касанию уже выбран
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();
  await page.getByTestId('outcome-details').getByRole('button', { name: 'Подумает' }).click();
  await page.getByTestId('sheet-save').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 1', { timeout: 15_000 });
  expect(await callsOf(op.id)).toHaveLength(0);
  // Плитка с итогом в очереди устройства заблокирована
  await expect(tileOf(page, op.names[0]!).getByTestId('tile-waiting')).toBeVisible();

  await context.setOffline(false);
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
  await expect(page.getByTestId('outbox-banner')).toBeHidden({ timeout: 20_000 });
  const [row] = await sql<{ state: string; attempts: number }[]>`SELECT state, attempts FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(row).toEqual({ state: 'callback', attempts: 0 });
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
  await expect(tile.getByTestId('tile-badge-attended')).toBeVisible();
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

// ---------- Шторка «Мусор» (ui-polish §9.3, B3) ----------

test('«Мусор»: причина без ЛПР - подсказка над кнопкой и обводка, после «Да» кнопка активна; заголовок и кнопка называют колонку', async ({ page }) => {
  const op = await makeOperator(1);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-trash').click();
  const sheet = page.getByTestId('trash-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('heading', { name: 'В «Мусор»: причина' })).toBeVisible();
  const confirm = page.getByTestId('trash-confirm');
  await expect(confirm).toHaveText('В «Мусор»');
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId('trash-missing')).toContainText('Выберите причину');
  await expect(page.getByText('Говорили с ЛПР — лицом, принимающим решение?')).toBeVisible();

  await page.getByTestId('trash-reason-not_interested-no_need').click();
  // Причина выбрана, ЛПР не отмечен: подсказка над кнопкой, сегмент обведён жёлтым, кнопка погашена нейтрально
  await expect(page.getByTestId('trash-missing')).toContainText('Отметьте, был ли разговор с ЛПР.');
  await expect(page.getByTestId('trash-lpr').locator('[data-missing="1"]')).toBeVisible();
  await expect(confirm).toBeDisabled();
  const opacity = await confirm.evaluate((el) => getComputedStyle(el).opacity);
  expect(opacity).toBe('1');
  await page.getByTestId('trash-lpr-yes').click();
  await expect(confirm).toBeEnabled();
  await expect(page.getByTestId('trash-missing')).toHaveCount(0);
  // «Не отвечает» погашено нейтрально (без opacity), причина названа текстом с подписью из настроек
  const off = page.getByTestId('trash-reason-written_off-unreachable');
  await expect(off).toBeDisabled();
  expect(await off.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(page.getByTestId('trash-call-first')).toHaveText('«Не отвечает» доступно после недозвона: сначала позвоните');
});

test('«Мусор»: «Другие причины…» группами с заголовком вида итога и последствием, без голых одинаковых «Другое (текст)»', async ({ page }) => {
  const op = await makeOperator(1);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-trash').click();
  await page.getByTestId('trash-more').click();
  const groups = page.locator('[data-testid^="trash-group-"]');
  expect(await groups.count()).toBeGreaterThanOrEqual(3);
  const titles = await groups.evaluateAll((els) => els.map((e) => e.querySelector('h3')?.textContent ?? ''));
  expect(new Set(titles).size).toBe(titles.length);
  // «Другое (текст)» есть у нескольких видов, но каждое - под своим заголовком
  const others = page.getByRole('button', { name: 'Другое (текст)' });
  expect(await others.count()).toBeGreaterThanOrEqual(3);
  for (const g of await groups.all()) await expect(g).toContainText(/Закрывается|Номер попадёт|Списывается/);
  await expect(page.getByTestId('trash-group-do_not_call')).toContainText('стоп-лист');
});

// ---------- Шторка лида (ui-polish §9.7, B5) ----------

test('шторка лида: «Следующий шаг», «Позвонить» ведёт в шторку итога этой карточки, ссылка на карточку помнит вкладку', async ({ page }) => {
  const op = await makeOperator(2);
  await sql`UPDATE cards SET state = 'callback', callback_reason = 'think', callback_touches = 1, next_call_precision = 'day', next_call_at = ${Date.now() + 86_400_000} WHERE id = ${op.cardIds[0]!}`;
  await openBoard(page, op);
  await page.getByTestId('tab-callback').click();
  await tileOf(page, op.names[0]!).getByTestId('tile-open').click();
  const drawer = page.getByTestId('lead-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('drawer-next-step')).toContainText('Следующий шаг');
  await expect(page.getByTestId('drawer-next-step')).toContainText('Подумает');
  await expect(page.getByTestId('drawer-history')).toBeVisible();
  await expect(page.getByTestId('drawer-whatsapp')).toBeVisible();
  await expect(page.getByTestId('drawer-move')).toBeVisible();
  // Открыть карточку - вторичная, с адресом возврата на вкладку (К3)
  await expect(page.getByTestId('drawer-open-card')).toHaveAttribute('href', `/clients/${op.clientIds[0]!}?from=board&tab=callback`);
  await expect(page.getByTestId('drawer-open-card')).toHaveClass(/k-btn--secondary/);

  await page.getByTestId('drawer-call').click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('lead-drawer')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText(op.names[0]!);
  await page.getByTestId('outcome-no_answer').click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  expect((await callsOf(op.id))[0]!.via).toBe('ui');
});

test('шторка лида: «Перенести в…» открывает список целей, а поля идут по шесть и «Ещё N полей» раскрывает остаток', async ({ page }) => {
  const op = await makeOperator(1);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-open').click();
  await expect(page.getByTestId('lead-drawer')).toBeVisible();
  const rows = page.getByTestId('drawer-fields').locator('> *');
  await expect(page.getByTestId('drawer-fields')).toBeVisible();
  const more = page.getByTestId('drawer-more-fields');
  if (await more.count()) {
    const before = await rows.count();
    expect(before).toBe(6);
    await more.click();
    expect(await rows.count()).toBeGreaterThan(before);
  }
  await page.getByTestId('drawer-move').click();
  await expect(page.getByTestId('move-menu')).toBeVisible();
  await expect(page.getByTestId('lead-drawer')).toHaveCount(0);
});

// ---------- Перенос: причины погашенных целей (B8) ----------

test('«Перенести в…»: «Позвонить» у цели записи ведёт к звонку этой карточки; в «Перезвон» нет системных причин нового лида', async ({ page }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  await tileOf(page, op.names[0]!).getByTestId('tile-menu').click();
  const menu = page.getByTestId('move-menu');
  await expect(menu.getByTestId('move-reason-br')).toContainText('Запись — через звонок');
  await expect(menu.getByTestId('move-to-br')).toHaveCSS('text-align', 'left');
  await menu.getByTestId('move-call').first().click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('move-menu')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Перенос второй карточки в «Перезвон»: заголовок без номера, у нового лида нет «Пришёл, не купил» и «Не пришёл»
  await page.getByTestId('call-resume').click();
  await page.getByTestId('outcome-no_answer').click();
  await tileOf(page, op.names[1]!).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();
  await page.getByTestId('outcome-callback').click();
  const details = page.getByTestId('outcome-details');
  await expect(details.getByRole('button', { name: 'Подумает' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Пришёл, не купил — дожать' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: /^Не пришёл/ })).toHaveCount(0);
  await expect(details.getByRole('button', { name: /^Не придёт/ })).toHaveCount(0);
  // Причины сеткой в две колонки
  const xs = await details.getByRole('button', { name: /Подумает|Пока не нужно/ }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(xs).size).toBe(2);
});

// ---------- Вид доски в адресе (ui-polish §9.6, контракт К1, B7) ----------

test('телефон: РОП ставит сотрудника и фильтр → открывает карточку → «Назад» возвращает тот же вид', async ({ page }) => {
  const rop = await makeOperator(0, { role: 'rop' });
  const op = await makeOperator(2);
  await sql`UPDATE cards SET last_no_show_at = ${Date.now() - 3_600_000} WHERE id = ${op.cardIds[0]!}`;
  await login(page, rop);
  await page.goto('/deals/calling');
  await expect(page.getByTestId('board-screen')).toBeVisible();
  // На телефоне одна строка: поиск и две кнопки-значка; «Звонить подряд» с доски убран
  await expect(page.getByTestId('board-search')).toBeVisible();
  await expect(page.getByTestId('board-filters-open')).toBeVisible();
  await expect(page.getByTestId('board-call-next')).toHaveCount(0);

  await page.getByTestId('board-filters-open').click();
  await page.getByTestId('filter-owner').selectOption(op.id);
  await page.getByTestId('filter-noShow').click();
  await page.getByTestId('filters-done').click();
  await expect(page.getByTestId('board-filters-open')).toHaveAccessibleName('Фильтры · 2');
  await expect(tileOf(page, op.names[0]!)).toBeVisible();
  await expect(tileOf(page, op.names[1]!)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`f=noShow.*owner=${op.id}|owner=${op.id}.*f=noShow`));

  await tileOf(page, op.names[0]!).getByTestId('tile-open').click();
  await page.getByTestId('drawer-open-card').click();
  await page.waitForURL(`**/clients/${op.clientIds[0]!}**`);
  await page.goBack();
  await expect(page.getByTestId('board-screen')).toBeVisible();
  await expect(tileOf(page, op.names[0]!)).toBeVisible();
  await expect(tileOf(page, op.names[1]!)).toHaveCount(0);
  await page.getByTestId('board-filters-open').click();
  await expect(page.getByTestId('filter-noShow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('filter-owner')).toHaveValue(op.id);
  await page.getByTestId('filters-reset').click();
  // В общей базе копятся карточки прошлых прогонов, поэтому проверяем вид, а не плитку: адрес чист, счётчика нет
  await expect(page).not.toHaveURL(/owner=|f=/);
  await expect(page.getByTestId('filter-noShow')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('filter-owner')).toHaveValue('');
});

test('телефон: адрес с вкладкой открывает нужную колонку, мусор в адресе отбрасывается', async ({ page }) => {
  const op = await makeOperator(1);
  await sql`UPDATE cards SET state = 'callback', callback_reason = 'think', callback_touches = 1, next_call_precision = 'day', next_call_at = ${Date.now() + 86_400_000} WHERE id = ${op.cardIds[0]!}`;
  await login(page, op);
  await page.goto('/board?tab=callback&f=hack,today&sort=zzz&owner=u-1');
  await expect(page.getByTestId('board-screen')).toBeVisible();
  await expect(page.getByTestId('tab-callback')).toHaveAttribute('aria-selected', 'true');
  // Неизвестные значения молча отброшены: сортировка по умолчанию, чужого сотрудника нет, фильтр «Сегодня» действует
  await expect(page.getByTestId('board-filters-open')).toHaveAccessibleName('Фильтры · 1');
  expect(new URL(page.url()).searchParams.get('owner')).toBeNull();
  expect(new URL(page.url()).searchParams.get('f')).toBe('today');
  await page.getByTestId('tab-new').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBeNull();
});

test('сортировка: на телефоне кнопка со шторкой только на вкладках рабочих колонок', async ({ page }) => {
  const op = await makeOperator(2);
  await openBoard(page, op);
  await expect(page.getByTestId('board-sort-open')).toBeVisible();
  await page.getByTestId('board-sort-open').click();
  await page.getByTestId('sort-due').click();
  await expect(page).toHaveURL(/sort=due/);
  await page.getByTestId('tab-purchase').click();
  await expect(page.getByTestId('board-sort-open')).toHaveCount(0);
});
