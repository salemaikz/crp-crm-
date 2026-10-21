// Экран «Звонить» на телефоне: вход → очередь → «Позвонить» → шторка → итог → следующая карточка; шторка
// переживает перезапуск; отмена за 5 с не доходит до сервера; установка на экран. Нужна БД e2e (E2E_DATABASE_URL).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { dumpDevice, expectNoClientTraces } from './support/device';
import { DB_URL, callAndOutcome, callsOf, cardTitle, fillAgreed, login, makeOperator, openCall, prepareDb, seedGroupEvents, sql } from './support/calling';

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
  await expect(page.getByTestId('call-today')).toContainText(/1\s*итог/);

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
  await expect(page.getByTestId('call-today')).toContainText(/0\s*итогов/);
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
  await expect(page.getByTestId('call-today')).toContainText(/1\/\d+\s*пропусков/);
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

test('в карточке очереди видны ЛПР (имя, должность, телефон) и последняя заметка', async ({ page }) => {
  const op = await makeOperator(2, { lpr: true });
  await openCall(page, op);
  await expect(page.getByTestId('call-lpr')).toContainText('ЛПР: Асель Синтетик, Директор');
  await expect(page.getByTestId('call-lpr')).toContainText(/тел\. \+7 709/);
  await expect(page.getByTestId('call-note')).toContainText('Просили перезвонить после обеда');
});

test('«Договорились»: ЛПР и ниша → «Записать клиента» → мастер в той же шторке → итог и запись одним запросом', async ({ page }) => {
  const op = await makeOperator(2, { lpr: true });
  await seedGroupEvents([{ id: randomUUID(), plusDays: 3 }, { id: randomUUID(), plusDays: 10 }]);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await fillAgreed(page);
  await page.getByTestId('sheet-book').click();

  // Мастер открылся в шторке, страница не уходила
  await expect(page.getByTestId('booking-panel')).toBeVisible();
  await expect(page).toHaveURL(/\/call$/);
  await page.getByRole('tab', { name: 'БР' }).click();
  await page.getByRole('button', { name: /^Записать на / }).click();
  await expect(page.getByText(new RegExp(`^Записать ${op.names[0]} на БР `))).toBeVisible();
  // Подтверждение не отправляет ничего, пока оператор не нажал «Подтвердить»
  expect(await callsOf(op.id)).toHaveLength(0);
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect(page.getByTestId('booking-panel')).toBeHidden();
  await expect(cardTitle(page)).toHaveText(op.names[1]!);

  // Итог и запись — одна строка каждого, ключ записи = opId итога, ЛПР-контакт передан
  const calls = await callsOf(op.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.applied).toBe('applied');
  const rows = await sql<{ requestId: string; status: string; kind: string; contactId: string | null }[]>`SELECT request_id AS "requestId", status, kind, contact_id AS "contactId" FROM bookings WHERE client_id = ${op.clientIds[0]!}`;
  expect(rows).toHaveLength(1);
  expect([rows[0]!.requestId, rows[0]!.status, rows[0]!.kind]).toEqual([calls[0]!.id, 'registered', 'group']);
  expect(rows[0]!.contactId).not.toBeNull();
  const [card] = await sql<{ state: string }[]>`SELECT state FROM cards WHERE id = ${op.cardIds[0]!}`;
  expect(card!.state).toBe('agreed');

  // Строка «Сегодня» — с сервера: итог, дозвон и запись
  await expect(page.getByTestId('call-today')).toContainText(/1\s*запись/);
});

test('«Запишу позже»: итог «Договорились» без записи и задача «записать» на следующий рабочий день', async ({ page }) => {
  const op = await makeOperator(2, { lpr: true });
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await fillAgreed(page);
  await page.getByTestId('sheet-later').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect(page.getByText('Сохранено. Запишите клиента позже')).toBeVisible();

  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [call] = await callsOf(op.id);
  expect(call!.outcome).toBe('agreed');
  expect(await sql`SELECT 1 FROM bookings WHERE client_id = ${op.clientIds[0]!}`).toHaveLength(0);
  const [task] = await sql<{ status: string; dueAt: number }[]>`SELECT status, due_at AS "dueAt" FROM tasks WHERE source_key = ${`agreement:${call!.id}`}`;
  expect(task?.status).toBe('open');
  expect(Number(task!.dueAt)).toBeGreaterThan(Date.now());
});

test('мастер недоступен без сети: сообщение и «Запишу позже» в той же шторке', async ({ page, context }) => {
  const op = await makeOperator(2, { lpr: true });
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await fillAgreed(page);
  await context.setOffline(true);
  await page.getByTestId('sheet-book').click();
  await expect(page.getByText('Мастер записи не открылся')).toBeVisible();
  await page.getByTestId('booking-later').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await context.setOffline(false);
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
});

test('«Сегодня» берётся с сервера: итоги с другого телефона учтены', async ({ page }) => {
  const op = await makeOperator(2);
  // Два итога поставлены на другом устройстве: на этом телефоне локального счётчика нет
  for (let i = 0; i < 2; i++) {
    const t = Date.now() - 60_000 * (i + 1);
    await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, applied, occurred_at, received_at, config_rev)
              SELECT ${randomUUID()}, c.space_id, c.id, c.client_id, ${op.id}, 'ui', '', 'agreed', 'agreed', 'applied', ${t}, ${t}, 1 FROM cards c WHERE c.id = ${op.cardIds[1]!}`;
  }
  await openCall(page, op);
  await expect(page.getByTestId('call-today')).toContainText(/2\s*итога/);
  await expect(page.getByTestId('call-today')).toContainText(/2\s*дозвона/);
});

test('колокольчик показывает число непрочитанных уведомлений', async ({ page }) => {
  const op = await makeOperator(1);
  for (let i = 0; i < 3; i++) {
    await sql`INSERT INTO notifications (id, user_id, kind, not_before, created_at) VALUES (${randomUUID()}, ${op.id}, 'digest', ${Date.now()}, ${Date.now() + i})`;
  }
  await openCall(page, op);
  await expect(page.getByRole('link', { name: 'Уведомления: 3' })).toBeVisible();
});

test('выход: неотправленные итоги уходят до выхода; без сети — предупреждение «N итогов ещё не отправлены»', async ({ page, context }) => {
  const op = await makeOperator(4);
  await openCall(page, op);
  await context.setOffline(true);
  await callAndOutcome(page, 'no_answer');
  await callAndOutcome(page, 'no_answer');
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 2', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('logout-unsent')).toContainText('2 итога ещё не отправлены');
  await page.getByTestId('logout-stay').click();
  await expect(page.getByTestId('logout-unsent')).toBeHidden();
  expect(await callsOf(op.id)).toHaveLength(0);

  // Сеть вернулась: «Выйти» сначала отправляет итоги, потом закрывает сессию и ведёт на вход
  await context.setOffline(false);
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login/);
  expect(await callsOf(op.id)).toHaveLength(2);
  await page.goto('/call');
  await expect(page).toHaveURL(/\/login/);
});

test('после выхода на телефоне нет названий и номеров клиентов: localStorage, IndexedDB, Cache Storage', async ({ page }) => {
  const op = await makeOperator(3, { lpr: true });
  await openCall(page, op);
  // Шторка открыта и черновик записан в localStorage; итог ушёл — после выхода от них не должно остаться следов
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  // Проверка не пустая: до выхода название компании на устройстве есть
  await expect.poll(async () => (await dumpDevice(page)).includes(op.names[0]!)).toBe(true);
  await page.getByTestId('outcome-no_answer').click();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 40_000 }).toBe(1);
  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByTestId('logout').click();
  await page.waitForURL(/\/login/);

  // Всё хранилище устройства (localStorage, все базы IndexedDB, Cache Storage): номера как в БД (7709…), названия, ЛПР
  await expectNoClientTraces(page, op);
});
