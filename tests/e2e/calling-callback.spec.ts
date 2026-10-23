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
  await page.getByTestId('callback-time').fill('15:30');
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

  // Пустое поле с правом правки — «Добавить …»; значение вводится на месте
  const edit = page.getByTestId('field-edit-district');
  await expect(edit).toContainText('Добавить');
  await edit.click();
  const input = page.locator('#f-call-district');
  await input.fill('Синтетический район');
  await input.press('Enter');
  await expect(page.getByText('Сохранено').last()).toBeVisible();
  await expect(page.getByTestId('field-edit-district')).toContainText('Синтетический район');
  await expect(page.getByText('Значение изменилось. Показано новое.')).toHaveCount(0);

  const [client] = await sql<{ custom: Record<string, unknown> }[]>`SELECT custom FROM clients WHERE id = ${op.clientIds[1]!}`;
  expect(client?.custom.district).toBe('Синтетический район');

  // Второе нажатие: значение уже есть, правка меняет его, «Отмена» ничего не пишет
  await page.getByTestId('field-edit-district').click();
  await page.locator('#f-call-district').fill('Другое');
  await page.getByTestId('field-cancel').click();
  await expect(page.getByTestId('field-edit-district')).toContainText('Синтетический район');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
