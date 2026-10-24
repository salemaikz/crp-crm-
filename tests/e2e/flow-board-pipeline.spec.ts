// Сквозной путь по доске на телефонах (pipeline-v2 §17, линия Q1): выдача → доска → перенос в «Перезвон» с причиной без
// времени → огонёк на следующий день → «Договорились» → запись на БР → «Не пришёл» → «Перезвон» с причиной →
// повторная запись → покупка → «Мои покупки». Проекты iPhone 13 (WebKit) и Pixel 7 (Chromium).
// Нужна БД e2e (E2E_DATABASE_URL) и сервер с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд; в бою флаги выключены).
//
// Время. Часы сервера не подменяются, ожидания нет: «следующий день» наступает сдвигом срока карточки и задачи на сутки
// назад в БД, как если бы прошла ночь (огонёк считается на сервере при чтении доски от срока и «сейчас»).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, callsOf, login, makeOperator, prepareDb, seedGroupEvents, sql, type Operator } from './support/calling';
import { makeConsultant, pretty } from './support/consult';
import { pickOwner } from './support/board';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1' || process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд)');

test.beforeAll(() => {
  prepareDb();
});

const DAY = 86_400_000;
const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function loginAs(page: Page, phone: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

async function openBoard(page: Page, tab?: string): Promise<void> {
  await page.goto('/board');
  await expect(page.getByTestId('board-screen')).toBeVisible();
  if (tab) await page.getByTestId(`tab-${tab}`).click();
}

/** Срок карточки и открытых задач перезвона — на 09:00 местных суток со сдвигом `days` от сегодняшних (управляемые «часы»). */
async function setDueDay(cardId: string, clientId: string, days: number): Promise<void> {
  const localMidnight = Math.floor((Date.now() + 5 * 3_600_000) / DAY) * DAY - 5 * 3_600_000;
  const at = localMidnight + days * DAY + 4 * 3_600_000;
  await sql`UPDATE cards SET next_call_at = ${at} WHERE id = ${cardId}`;
  await sql`UPDATE tasks SET due_at = ${at} WHERE client_id = ${clientId} AND source IN ('callback', 'no_show') AND status = 'open'`;
}

/** Наступил день БР: встреча записи (без неё явку не отметить) началась час назад, но не раньше начала местных суток. */
async function startMeeting(cardId: string): Promise<void> {
  const t = Date.now();
  const localMidnight = Math.floor((t + 5 * 3_600_000) / DAY) * DAY - 5 * 3_600_000;
  const startsAt = Math.max(t - 3_600_000, localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  const date = stamp.slice(0, 10);
  const time = stamp.slice(11, 16);
  await sql`UPDATE events SET event_date = ${date}, start_time = ${time}, starts_at = ${startsAt}, updated_at = ${t}
            WHERE id IN (SELECT event_id FROM bookings WHERE card_id = ${cardId} AND status = 'registered' AND event_id IS NOT NULL)`;
  await sql`UPDATE bookings SET booking_date = ${date}, start_time = ${time}, starts_at = ${startsAt}, updated_at = ${t} WHERE card_id = ${cardId} AND status = 'registered'`;
}

/** «Позвонить» на плитке → «Договорились» → мастер записи в шторке → ближайшее БР → «Подтвердить». */
async function agreeAndBook(page: Page, op: Operator): Promise<void> {
  await tileOf(page, op.names[0]!).getByTestId('tile-call').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-agreed').click();
  const niche = page.getByTestId('outcome-details').getByRole('combobox');
  await expect(async () => {
    await niche.selectOption({ label: 'Розница' });
    await expect(niche).toHaveValue(/.+/, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.getByTestId('sheet-book')).toBeEnabled();
  await page.getByTestId('sheet-book').click();
  // Запись ведёт экран «Звонить»: черновик итога переезжает туда, шторка открывается сама
  await page.waitForURL('**/call');
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  // Значение ниши в черновик не переезжает (замечание линии U2): если шторка его потеряла, выбираем заново
  const nicheOnCall = page.getByTestId('outcome-details').getByRole('combobox');
  if ((await nicheOnCall.inputValue()) === '') await nicheOnCall.selectOption({ label: 'Розница' });
  await expect(page.getByTestId('sheet-book')).toBeEnabled();
  await page.getByTestId('sheet-book').click();
  await expect(page.getByTestId('booking-panel')).toBeVisible();
  await page.getByRole('tab', { name: 'БР' }).click();
  await page.getByRole('button', { name: /^Записать на / }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect(page.getByTestId('booking-panel')).toBeHidden();
  await openBoard(page);
}

test('сквозной путь: перезвон без времени → огонёк → БР → неявка → перезвон → повторная запись → покупка → «Мои покупки»', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const op = await makeOperator(2, { lpr: true });
  const cardId = op.cardIds[0]!;
  const name = op.names[0]!;
  await login(page, op);
  await openBoard(page);

  // 1. Выдача: обе карточки в «Новые»
  await expect(tileOf(page, name)).toBeVisible();
  await expect(tileOf(page, op.names[1]!)).toBeVisible();
  expect(await noHScroll(page)).toBe(true);

  // 2. Перенос в «Перезвон»: причина «Подумает», срок без времени
  await tileOf(page, name).getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();
  await page.getByTestId('outcome-details').getByRole('button', { name: 'Подумает' }).click();
  await page.getByTestId('callback-hint').click();
  await expect(page.getByTestId('callback-chosen')).toContainText('в течение дня');
  await expect(page.getByTestId('callback-with-time')).not.toBeChecked();
  await page.getByTestId('sheet-save').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 30_000 }).toBe(1);
  expect((await callsOf(op.id))[0]!.via).toBe('board');
  const [cb] = await sql<{ state: string; precision: string; reason: string }[]>`
    SELECT state, next_call_precision AS precision, callback_reason AS reason FROM cards WHERE id = ${cardId}`;
  expect(cb).toEqual({ state: 'callback', precision: 'day', reason: 'think' });

  // 3. Срок «в течение дня» ещё впереди — огонька нет; настал день срока — «сегодня»; прошла ночь — «просрочен»
  await page.reload();
  await page.getByTestId('tab-callback').click();
  await expect(tileOf(page, name)).toBeVisible();
  await expect(tileOf(page, name).getByTestId('tile-fire')).toHaveCount(0);
  await setDueDay(cardId, op.clientIds[0]!, 0);
  await page.reload();
  await page.getByTestId('tab-callback').click();
  await expect(tileOf(page, name).getByTestId('tile-fire')).toContainText('Перезвон сегодня');
  await setDueDay(cardId, op.clientIds[0]!, -1);
  await page.reload();
  await page.getByTestId('tab-callback').click();
  await expect(tileOf(page, name).getByTestId('tile-fire')).toContainText('Перезвон просрочен');

  // 4. «Договорились» и запись на БР
  await seedGroupEvents([{ id: randomUUID(), plusDays: 3 }, { id: randomUUID(), plusDays: 10 }]);
  await agreeAndBook(page, op);
  await expect
    .poll(async () => (await sql<{ state: string; status: string }[]>`SELECT c.state, b.status FROM cards c JOIN bookings b ON b.card_id = c.id WHERE c.id = ${cardId}`)[0], { timeout: 30_000 })
    .toEqual({ state: 'agreed', status: 'registered' });
  await page.reload();
  await page.getByTestId('tab-br').click();
  await expect(tileOf(page, name)).toBeVisible();
  // Оператор явку не отмечает: переключателя нет вовсе, а запись видна чипом (без слова «Не подтвердил»)
  await expect(tileOf(page, name).getByRole('switch')).toHaveCount(0);
  await expect(tileOf(page, name).getByTestId('tile-chip')).not.toContainText('Не подтвердил');
  await expect(tileOf(page, name).getByTestId('tile-chip')).toContainText(/БР/);
  expect(await noHScroll(page)).toBe(true);

  await startMeeting(cardId);
  // 5. РОП на своём устройстве отмечает «Не пришёл» переносом в «Перезвон»: причина и срок подставлены
  const rop = await makeOperator(0, { role: 'rop' });
  await sql`UPDATE users SET name = ${'РОП Синтетик ' + rop.id.slice(0, 4)} WHERE id = ${rop.id}`;
  const ropCtx = await browser.newContext(test.info().project.use);
  const ropPage = await ropCtx.newPage();
  try {
    await login(ropPage, rop);
    await ropPage.goto('/deals/calling');
    await pickOwner(ropPage, op.id);
    await ropPage.getByTestId('tab-br').click();
    await tileOf(ropPage, name).getByTestId('tile-menu').click();
    await ropPage.getByTestId('move-to-callback').click();
    await expect(ropPage.getByTestId('exit-sheet')).toBeVisible();
    await ropPage.getByTestId('exit-att-no_show').click();
    await expect(ropPage.getByTestId('exit-reason-no_show_br')).toHaveAttribute('aria-pressed', 'true');
    await expect(ropPage.getByTestId('callback-chosen')).toBeVisible();
    await ropPage.getByTestId('exit-confirm').click();
    await expect(ropPage.getByTestId('exit-sheet')).toBeHidden();
    await expect
      .poll(async () => (await sql<{ state: string; reason: string; status: string }[]>`
        SELECT c.state, c.callback_reason AS reason, b.status FROM cards c JOIN bookings b ON b.card_id = c.id WHERE c.id = ${cardId}`)[0], { timeout: 30_000 })
      .toEqual({ state: 'callback', reason: 'no_show_br', status: 'no_show' });
  } finally {
    await ropCtx.close();
  }

  // 6. У оператора плитка в «Перезвоне» с причиной неявки и значком «не пришёл»; срок настал — огонёк
  await setDueDay(cardId, op.clientIds[0]!, -1);
  await page.reload();
  await page.getByTestId('tab-callback').click();
  await expect(tileOf(page, name)).toBeVisible();
  // Неявка уже сказана причиной в чипе, отдельного значка «Не пришёл» нет
  await expect(tileOf(page, name).getByTestId('tile-chip')).toContainText('Не пришёл');
  await expect(tileOf(page, name).getByTestId('tile-badge-noShow')).toHaveCount(0);
  await expect(tileOf(page, name).getByTestId('tile-fire')).toContainText('Перезвон просрочен');

  // 7. Повторная запись: новая встреча, прежняя запись остаётся «не пришёл»
  await seedGroupEvents([{ id: randomUUID(), plusDays: 4 }, { id: randomUUID(), plusDays: 11 }]);
  await agreeAndBook(page, op);
  await expect
    .poll(async () => (await sql<{ status: string }[]>`SELECT status FROM bookings WHERE card_id = ${cardId} ORDER BY created_at`).map((b) => b.status), { timeout: 30_000 })
    .toEqual(['no_show', 'registered']);
  const [again] = await sql<{ state: string }[]>`SELECT state FROM cards WHERE id = ${cardId}`;
  expect(again!.state).toBe('agreed');
  const openDeals = await sql<{ id: string }[]>`SELECT id FROM deals WHERE card_id = ${cardId} AND status = 'open'`;
  expect(openDeals).toHaveLength(1);

  // 8. Покупка: консультант регистрирует её по открытой сделке (встреча консультанта завтра — окно открыто)
  const consultant = await makeConsultant();
  const t = Date.now();
  const tomorrow = new Date(t + 5 * 3_600_000 + DAY).toISOString().slice(0, 10);
  await sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, direction_key,
                          status, booked_by_user_id, responsible_user_id, version, created_at, updated_at)
    VALUES (${randomUUID()}, ${space!.id}, 'individual', 'bk', ${consultant.resourceId}, ${op.clientIds[0]!}, ${cardId}, ${openDeals[0]!.id}, ${tomorrow}, '11:00', ${t + DAY}, 45,
            'marketing', 'registered', ${op.id}, ${op.id}, 0, ${t}, ${t})`;
  const consultCtx = await browser.newContext(test.info().project.use);
  const consultPage = await consultCtx.newPage();
  try {
    await loginAs(consultPage, consultant.phone);
    await consultPage.goto(`/deals/purchase/${cardId}`);
    await expect(consultPage.getByText(name)).toBeVisible();
    await consultPage.getByLabel('Услуга').selectOption('smm');
    await consultPage.getByLabel('Сумма, ₸').fill('450000');
    expect(await noHScroll(consultPage)).toBe(true);
    await consultPage.getByRole('button', { name: 'Зарегистрировать' }).click();
    await consultPage.waitForURL(`**/deals/${openDeals[0]!.id}`);
  } finally {
    await consultCtx.close();
  }
  const [won] = await sql<{ status: string; amount: string }[]>`SELECT status, amount_kzt::text AS amount FROM deals WHERE id = ${openDeals[0]!.id}`;
  expect(won).toEqual({ status: 'won', amount: '450000' });

  // 9. «Покупка» на доске и «Мои покупки»: сделка засчитана оператору, сумма в итоге месяца
  await page.reload();
  await page.getByTestId('tab-purchase').click();
  await expect(page.getByTestId('purchases-month')).toContainText('450');
  await page.getByTestId('purchases-link').click();
  await page.waitForURL('**/board/purchases');
  await expect(page.getByTestId('purchases-screen')).toBeVisible();
  await expect(page.getByTestId('purchases-list').getByText(name)).toBeVisible();
  await expect(page.getByTestId('purchases-month-total')).toContainText('450');
  expect(await noHScroll(page)).toBe(true);
});
