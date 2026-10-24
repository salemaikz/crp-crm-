// Воронка v2, шторка перезвона и ввод поля на месте (pipeline-v2 §4.2, §9.6; линия C3). Нужна БД e2e
// (E2E_DATABASE_URL) и сервер, запущенный с FEATURE_CALLBACK_V2=1 (стенд; в бою флаг выключен).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { expect, test } from '@playwright/test';
import { DB_URL, callsOf, cardTitle, makeOperator, openCall, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_CALLBACK_V2=1 (стенд)');

test.beforeAll(() => {
  prepareDb();
});

test('перезвон с причиной «Подумает» без времени: карточка в перезвонах «в течение дня», системные причины не видны', async ({ page }) => {
  const op = await makeOperator(2);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();

  const details = page.getByTestId('outcome-details');
  // Ручные причины видны, системные (`manual: false`) — нет
  await expect(details.getByRole('button', { name: 'Подумает' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Пока не нужно' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Повторная продажа' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Вернулся через 90 дней' })).toHaveCount(0);

  // Причина обязательна: без неё «Сохранить» недоступна
  await expect(page.getByTestId('sheet-save')).toBeDisabled();
  await details.getByRole('button', { name: 'Подумает' }).click();

  // Подсказка по касанию: первое касание, срок без времени
  const hint = page.getByTestId('callback-hint');
  await expect(hint).toContainText('1-е касание');
  await hint.click();
  await expect(page.getByTestId('callback-chosen')).toContainText('в течение дня');
  await expect(page.getByTestId('callback-with-time')).not.toBeChecked();

  await page.getByTestId('sheet-save').click();
  await expect(sheet).toBeHidden();
  await expect(cardTitle(page)).toHaveText(op.names[1]!);

  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [row] = await sql<{ state: string; precision: string; reason: string; touches: number }[]>`
    SELECT state, next_call_precision AS precision, callback_reason AS reason, callback_touches AS touches FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(row).toEqual({ state: 'callback', precision: 'day', reason: 'think', touches: 1 });
  const [task] = await sql<{ precision: string }[]>`SELECT due_precision AS precision FROM tasks WHERE client_id = ${op.clientIds[0]!} AND source = 'callback' ORDER BY created_at DESC LIMIT 1`;
  expect(task?.precision).toBe('day');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('переключатель «Указать время» даёт срок с точностью «время»', async ({ page }) => {
  const op = await makeOperator(1);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();
  await page.getByTestId('outcome-details').getByRole('button', { name: 'Подумает' }).click();
  await page.getByTestId('callback-tomorrow').click();
  await page.getByTestId('callback-with-time').check();
  await page.getByTestId('callback-time').selectOption('15:30');
  await expect(page.getByTestId('callback-chosen')).toContainText('15:30');
  await page.getByTestId('sheet-save').click();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [row] = await sql<{ precision: string; at: string }[]>`SELECT next_call_precision AS precision, next_call_at AS at FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(row?.precision).toBe('time');
  expect(new Date(Number(row?.at)).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' })).toBe('15:30');
});

test('правка поля в карточке обзвона, пока итог по предыдущей карточке в очереди устройства, сохраняется без конфликта', async ({ page }) => {
  const op = await makeOperator(2);
  await openCall(page, op);
  // Итог по первой карточке ждёт в очереди устройства (окно отмены)
  await page.getByTestId('call-button').click();
  await page.getByTestId('outcome-no_answer').click();
  await expect(cardTitle(page)).toHaveText(op.names[1]!);

  // Пустые поля с правом правки свёрнуты в «Пустые поля (N)»; значение вводится на месте
  await page.getByTestId('fields-empty-toggle').click();
  const edit = page.getByTestId('inline-open-client-district');
  await expect(edit).toContainText('Добавить');
  await edit.click();
  const input = page.getByRole('textbox', { name: 'Район' });
  await input.fill('Синтетический район');
  await input.press('Enter');
  await expect(page.getByTestId('inline-client-district')).toContainText('Синтетический район');
  await expect(page.getByText('Значение изменилось. Показано новое.')).toHaveCount(0);

  const [client] = await sql<{ custom: Record<string, unknown> }[]>`SELECT custom FROM clients WHERE id = ${op.clientIds[1]!}`;
  expect(client?.custom.district).toBe('Синтетический район');

  // Второе нажатие: значение уже есть, правка меняет его, Esc ничего не пишет
  await page.getByTestId('inline-open-client-district').click();
  await page.getByRole('textbox', { name: 'Район' }).fill('Другое');
  await page.getByTestId('inline-cancel').click();
  await expect(page.getByTestId('inline-client-district')).toContainText('Синтетический район');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// ---------- Шторка перезвона: срок выбран сразу (ui-polish §9.3, B4) ----------

test('«Перезвонить» → причина: срок по касанию уже выбран, «Сохранить · день» активна без выбора срока', async ({ page }) => {
  const op = await makeOperator(2);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();

  const details = page.getByTestId('outcome-details');
  // Видимые подписи групп: на телефоне aria-label не виден
  await expect(details.getByText('Причина', { exact: true })).toBeVisible();
  await expect(details.getByText('Когда перезвонить', { exact: true })).toBeVisible();
  // Срок выбран до выбора причины; выбор срока стоит выше заметки
  await expect(page.getByTestId('callback-hint')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('callback-chosen')).toBeVisible();
  const pickerY = (await page.getByTestId('callback-picker').boundingBox())!.y;
  const noteY = (await details.locator('textarea').boundingBox())!.y;
  expect(pickerY).toBeLessThan(noteY);

  // Причины нет - в подвале сказано, чего не хватает; после причины кнопка активна
  const save = page.getByTestId('sheet-save');
  await expect(save).toBeDisabled();
  await expect(page.getByTestId('sheet-missing')).toContainText('Выберите причину');
  await details.getByRole('button', { name: 'Подумает' }).click();
  await expect(save).toBeEnabled();
  await expect(save).toHaveText(/^Сохранить · \S+ \d\d\.\d\d$/);
  await expect(page.getByTestId('sheet-missing')).toHaveCount(0);
  const hintText = await page.getByTestId('callback-chosen').textContent();

  await save.click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [row] = await sql<{ at: string; precision: string }[]>`SELECT next_call_at AS at, next_call_precision AS precision FROM cards WHERE id = ${op.cardIds[0]!}`;
  // Сохранённый срок — день подсказки (первое касание: через 3 дня, в течение дня)
  expect(row!.precision).toBe('day');
  const day = new Date(Number(row!.at)).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', weekday: 'short', day: '2-digit', month: '2-digit' });
  expect(hintText ?? '').toContain(day.replace(/\.$/, '').split(', ')[1] ?? day);
});

// ---------- Круг 3, B6 (D-358): итог сворачивается, «Когда перезвонить» виден без прокрутки, время — слоты 24 ч ----------

test('шторка перезвона: итог свёрнут в «Перезвонить ✓ · Изменить», дата видна без прокрутки, слоты 24 ч, «Сохранить» зелёная как «Позвонить»', async ({ page }, testInfo) => {
  const op = await makeOperator(2);
  await openCall(page, op);
  const callBg = await page.getByTestId('call-button').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();

  const selected = page.getByTestId('outcome-selected');
  await expect(selected).toContainText('Перезвонить');
  await expect(selected.getByTestId('outcome-change')).toHaveText('Изменить');
  await expect(page.getByTestId('outcome-callback')).toHaveCount(0);
  await page.getByTestId('outcome-details').getByRole('button', { name: 'Подумает' }).click();

  // «Когда перезвонить» под причинами и целиком над кнопкой сохранения, без прокрутки шторки
  const picker = (await page.getByTestId('callback-picker').boundingBox())!;
  const save = (await page.getByTestId('sheet-save').boundingBox())!;
  const inner = await page.evaluate(() => window.innerHeight);
  expect(picker.y + picker.height).toBeLessThanOrEqual(save.y + 0.5);
  expect(picker.y + picker.height).toBeLessThanOrEqual(inner);

  // Причины — сетка в две колонки, высота не меньше 44 px
  const chips = await page.getByTestId('outcome-details').getByRole('group', { name: 'Причина' }).getByRole('button').evaluateAll((els) => els.map((e) => ({ h: e.getBoundingClientRect().height, x: Math.round(e.getBoundingClientRect().x) })));
  expect(Math.min(...chips.map((c) => c.h))).toBeGreaterThanOrEqual(44);
  expect(new Set(chips.map((c) => c.x)).size).toBe(2);

  // Время — список слотов HH:mm, без «AM/PM»
  await page.getByTestId('callback-with-time').check();
  const time = page.getByTestId('callback-time');
  const options = await time.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(10);
  expect(options.every((o) => /^\d{2}:\d{2}$/.test(o))).toBe(true);
  expect(options.join(' ')).not.toMatch(/AM|PM/i);
  expect(await page.evaluate(() => document.querySelector('input[type="time"]') === null)).toBe(true);
  await testInfo.attach('callback-sheet-time', { body: await page.screenshot(), contentType: 'image/png' });

  // «Сохранить · день» того же зелёного, что «Позвонить»; выбранный итог без акцента и красного
  const saveBg = await page.getByTestId('sheet-save').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(saveBg).toBe(callBg);
  expect(await selected.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(await page.evaluate(() => getComputedStyle(document.body).color));

  // «Изменить» возвращает сетку итогов
  await selected.getByTestId('outcome-change').click();
  await expect(page.getByTestId('outcome-callback')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
