// Экран «Звонить» на телефоне: вход → очередь → «Позвонить» → шторка → итог → следующая карточка; шторка
// переживает перезапуск; отмена за 5 с не доходит до сервера; установка на экран. Нужна БД e2e (E2E_DATABASE_URL).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { expect, test } from '@playwright/test';
import { DB_URL, callAndOutcome, callsOf, cardTitle, login, makeOperator, openCall, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});
// Соединение с БД общее для файлов сценариев (один рабочий процесс): закроется вместе с процессом

test('вход → очередь → Позвонить → шторка → «Не берёт» → следующая карточка, итог на сервере', async ({ page }) => {
  const op = await makeOperator(8);
  await openCall(page, op);
  await expect(page.getByTestId('call-counts')).toContainText('К звонку сейчас: 8');
  await expect(cardTitle(page)).toHaveText(op.names[0]!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Главное действие — одна большая кнопка «Позвонить» со ссылкой tel:
  const call = page.getByTestId('call-button');
  await expect(call).toHaveAttribute('href', /^tel:\+7709\d{7}$/);
  const box = await call.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await call.click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  // Семь кнопок итогов из настроек в порядке регламента
  const labels = await sheet.locator('[data-outcome]').allTextContents();
  expect(labels).toEqual(['Не берёт', 'Номер не работает', 'Перезвонить', 'Договорились — записать', 'Не интересует', 'Не целевой', 'Полный отказ']);

  await page.getByTestId('outcome-no_answer').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('Сохранено')).toBeVisible();
  await expect(cardTitle(page)).toHaveText(op.names[1]!);
  await expect(page.getByTestId('call-today')).toContainText('1 итог');

  // Итог дошёл до сервера после окна отмены
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [row] = await callsOf(op.id);
  expect(row).toMatchObject({ cardId: op.cardIds[0], outcome: 'no_answer', applied: 'applied' });
  const [card] = await sql<{ state: string; attempts: number }[]>`SELECT state, attempts FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(card).toEqual({ state: 'retry', attempts: 1 });

  // Сервер получил заголовки устройства (D-063)
  await expect
    .poll(async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM device_status WHERE user_id = ${op.id}`)[0]!.n, { timeout: 20_000 })
    .toBe(1);
});

test('«Отменить» за 5 секунд: итог не доходит до сервера, карточка и шторка возвращаются', async ({ page }) => {
  const op = await makeOperator(4);
  await openCall(page, op);
  await callAndOutcome(page, 'no_answer');
  await expect(cardTitle(page)).toHaveText(op.names[1]!);
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(cardTitle(page)).toHaveText(op.names[0]!);
  // Окно отмены давно прошло бы — на сервере итога нет
  await page.waitForTimeout(8_000);
  expect(await callsOf(op.id)).toHaveLength(0);
  await expect(page.getByTestId('call-today')).toContainText('0 итогов');
});

test('шторка и отмеченное в ней переживают перезапуск; закрытая шторка открывается кнопкой «Указать итог»', async ({ page }) => {
  const op = await makeOperator(3);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await expect(page.getByTestId('lpr-yes')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await expect(page.getByTestId('lpr-yes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog')).toContainText(op.names[0]!);

  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await page.getByTestId('call-resume').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  expect(await callsOf(op.id)).toHaveLength(0);
});

test('«Перезвонить» требует ЛПР и срок; «Сохранить» оживает, когда всё указано', async ({ page }) => {
  const op = await makeOperator(2);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await page.getByTestId('outcome-callback').click();
  const save = page.getByTestId('sheet-save');
  await expect(save).toBeDisabled();
  await page.getByTestId('lpr-yes').click();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: /Через 2 часа/ }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [card] = await sql<{ state: string; next: string | null }[]>`SELECT state, next_call_at AS next FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(card?.state).toBe('callback');
  expect(Number(card?.next)).toBeGreaterThan(Date.now() + 100 * 60_000);
});

test('«Пропустить»: карточка уходит в конец очереди, счётчик пропусков растёт', async ({ page }) => {
  const op = await makeOperator(3);
  await openCall(page, op);
  await page.getByTestId('call-skip').click();
  await expect(cardTitle(page)).toHaveText(op.names[1]!);
  await expect(page.getByTestId('call-today')).toContainText('пропусков 1 из');
  await expect.poll(async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM skips WHERE user_id = ${op.id}`)[0]!.n).toBe(1);
});

test('установка на главный экран: манифест с цветами темы, иконки, service worker только для оболочки', async ({ page, request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const m = (await res.json()) as { start_url: string; display: string; theme_color: string; background_color: string; icons: Array<{ src: string; sizes: string; type: string }> };
  expect(m.start_url).toBe('/call');
  expect(m.display).toBe('standalone');
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512']);
  for (const icon of m.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toMatch(/javascript/);

  const op = await makeOperator(2);
  await openCall(page, op);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect(page.getByTestId('call-card')).toBeVisible();
  // После перезапуска без сети оболочка открывается, ПДн карточек в кэше нет
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByText('Нет сети, итоги сохранены')).toBeVisible();
  await expect(page.getByText(op.names[0]!)).toHaveCount(0);
  await page.context().setOffline(false);
});

test('вход обязателен: без сессии страница ведёт на вход', async ({ page }) => {
  await page.goto('/call');
  await expect(page).toHaveURL(/\/login/);
  await login(page, await makeOperator(1));
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
});

test('«Договорились — записать» ведёт в мастер записи с карточкой и opId; звонок без итога не теряется', async ({ page }) => {
  const op = await makeOperator(2);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await page.getByTestId('outcome-agreed').click();
  await expect(page).toHaveURL(new RegExp(`/book\\?card=${op.cardIds[0]}&opId=[0-9a-f-]{36}&from=call`));
  expect(await callsOf(op.id)).toHaveLength(0);
});
