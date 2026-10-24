// Q1b: полный путь пилота на мобильном размере одним сценарием и гейты дня 4.
// Оператор берёт карточку → «Позвонить» → «Договорились» → запись на БР (2 нажатия) → повтор = перенос → заявка на БК →
// РОП видит запись и «серую» заявку → дежурный отмечает явку → консультант ставит итог встречи → покупка в целых тенге →
// передача в отдел → глава отдела принимает → отчёт за период и панель директора показывают звонок, запись, явку, покупку.
// Время: серверное «сейчас» не подменяется, начало мероприятия и встречи сдвигается в БД на час назад (как в booking-duty).
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у запущенного сервера); флаги стенда — playwright.config.ts.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, callAndOutcome, callsOf, cardTitle, fillAgreed, login, makeOperator, openCall, pickCallbackTerm, prepareDb, seedGroupEvents, sql } from './support/calling';
import { makeConsultant, pretty } from './support/consult';
import { uniquePhone } from './support/phones';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(() => prepareDb());

async function makeStaff(role: string, name: string, teamId: string | null = null): Promise<{ id: string; phone: string; name: string }> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = (await uniquePhone(sql));
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, ${role}, ${teamId}, FALSE, ${t}, ${t})`;
  return { id, phone, name };
}

/** Войти другим сотрудником в том же браузере (сессия прежнего закрывается вместе с cookie). */
async function loginAs(page: Page, phone: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

/** Местное время начала: час назад, но не раньше начала местных суток (Asia/Almaty, UTC+5). */
function startedAgo(): { date: string; time: string; startsAt: number } {
  const t = Date.now();
  const localMidnight = Math.floor((t + 5 * 3_600_000) / 86_400_000) * 86_400_000 - 5 * 3_600_000;
  const startsAt = Math.max(t - 3_600_000, localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  return { date: stamp.slice(0, 10), time: stamp.slice(11, 16), startsAt };
}

interface DirectorNumbers {
  calls: { outcomes: number; connects: number };
  bookings: { groups: number; consults: number };
  attendance: { attended: number; noShow: number };
  purchases: { count: number; sumKzt: number };
}

async function directorNumbers(page: Page): Promise<DirectorNumbers> {
  const res = await page.request.get('/api/reports/director');
  expect(res.status()).toBe(200);
  return (await res.json()) as DirectorNumbers;
}

test('путь пилота: звонок → «Договорились» → БР → перенос → БК → явка → итог встречи → покупка → передача → отчёты', async ({ page }) => {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const spaceId = space!.id;
  const [team] = await sql<{ id: string }[]>`SELECT id FROM teams WHERE space_id = ${spaceId} AND key = 'marketing' AND archived_at IS NULL`;
  const tag = digits(5);
  const consultant = await makeConsultant({ exclusive: true });
  const rop = await makeStaff('rop', `РОП Пилот ${tag}`);
  const duty = await makeStaff('operator', `Дежурный Пилот ${tag}`);
  const director = await makeStaff('director', `Директор Пилот ${tag}`);
  const head = await makeStaff('marketing_head', `Глава отдела Пилот ${tag}`, team!.id);
  await sql`UPDATE teams SET lead_user_id = ${head.id} WHERE id = ${team!.id}`;
  const op = await makeOperator(2, { lpr: true });
  // Имя уникально: в общей e2e-базе остаются операторы прежних сценариев с тем же именем
  await sql`UPDATE users SET name = ${`Оператор Пилот ${tag}`} WHERE id = ${op.id}`;
  const [cardId] = op.cardIds as [string, string];
  const [clientId] = op.clientIds as [string];
  const [name, otherName] = op.names as [string, string];
  const [eventA, eventB] = [randomUUID(), randomUUID()];
  await seedGroupEvents([{ id: eventA, plusDays: 3 }, { id: eventB, plusDays: 10 }]);

  // Базовые числа недели до сценария: панель директора отвечает за всё пространство, поэтому сравниваем приращение
  await loginAs(page, director.phone);
  const before = await directorNumbers(page);

  // --- 1. оператор: первая карточка очереди → «Позвонить» → «Договорились» ---
  await login(page, op);
  await page.goto('/call');
  await expect(page.getByTestId('call-card')).toBeVisible();
  await expect(cardTitle(page)).toHaveText(name);
  expect(await noHScroll(page)).toBe(true);
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await fillAgreed(page);

  // --- 2. запись на БР: в открывшемся мастере ровно 2 нажатия ---
  await page.getByTestId('sheet-book').click();
  await expect(page.getByTestId('booking-panel')).toBeVisible();
  await page.getByRole('tab', { name: 'БР' }).click(); // выбор вида мероприятия, а не действие записи
  await page.getByRole('button', { name: /^Записать на / }).click(); // нажатие 1
  await expect(page.getByText(new RegExp(`^Записать ${name} на БР `))).toBeVisible();
  expect(await sql`SELECT 1 FROM bookings WHERE client_id = ${clientId}`).toHaveLength(0);
  await page.getByRole('button', { name: 'Подтвердить' }).click(); // нажатие 2
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  await expect(cardTitle(page)).toHaveText(otherName);

  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [call] = await callsOf(op.id);
  expect(call).toMatchObject({ cardId, outcome: 'agreed', applied: 'applied' });
  const [first] = await sql<{ requestId: string; status: string; eventId: string }[]>`SELECT request_id AS "requestId", status, event_id AS "eventId" FROM bookings WHERE client_id = ${clientId}`;
  expect([first?.requestId, first?.status, first?.eventId]).toEqual([call!.id, 'registered', eventA]);

  // --- 3. повторная запись на БР = перенос на следующее мероприятие (D-042) ---
  await page.goto(`/bookings/new/${cardId}`);
  await page.getByRole('tab', { name: 'БР' }).click();
  await expect(page.getByText(/^Сейчас: /)).toBeVisible();
  await page.getByRole('button', { name: /^Перенести на / }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Перенесено: БР/).first()).toBeVisible();
  const group = await sql<{ status: string; eventId: string }[]>`SELECT status, event_id AS "eventId" FROM bookings WHERE client_id = ${clientId} AND kind = 'group' ORDER BY created_at`;
  expect(group.map((b) => [b.status, b.eventId])).toEqual([['moved', eventA], ['registered', eventB]]);

  // --- 4. заявка на консультацию без консультанта («серая») ---
  await page.goto(`/bookings/new/${cardId}`);
  await page.getByRole('tab', { name: 'БК' }).click();
  await page.getByRole('button', { name: 'Маркетинг' }).click();
  await page.getByRole('group', { name: 'День' }).getByRole('button').first().click();
  await page.getByRole('group', { name: 'Время' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Назначим утром' }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Заявка: БК, /).first()).toBeVisible();
  const [grey] = await sql<{ id: string; resourceId: string | null; bookingDate: string; dealId: string | null }[]>`
    SELECT id, resource_id AS "resourceId", booking_date AS "bookingDate", deal_id AS "dealId" FROM bookings WHERE client_id = ${clientId} AND kind = 'individual'`;
  expect(grey?.resourceId).toBeNull();

  // --- 5. РОП видит запись на БР, заявку и плитку «серых» ---
  await loginAs(page, rop.phone);
  await page.goto('/bookings');
  // В общей e2e-базе есть чужие «серые» заявки: смотрим только строки нашего клиента
  const mineRows = page.getByRole('link').filter({ hasText: name });
  await expect(mineRows).toHaveCount(2);
  await expect(mineRows.filter({ hasText: 'БР' })).toContainText('Записан');
  await expect(mineRows.filter({ hasText: 'БК' })).toContainText('Без консультанта');
  expect(await noHScroll(page)).toBe(true);
  await page.goto('/summary');
  const summary = (await (await page.request.get('/api/reports/summary')).json()) as { tiles: { grey: { waiting: number } } };
  expect(summary.tiles.grey.waiting).toBeGreaterThanOrEqual(1);
  const greyTile = page.locator('.k-stat').filter({ hasText: 'Заявки на консультацию' });
  await expect(greyTile.locator('.k-stat__value')).toHaveText(String(summary.tiles.grey.waiting));
  expect(await noHScroll(page)).toBe(true);

  // --- 6. РОП назначает дежурного на БР и консультанта на «серую» заявку ---
  await page.goto('/bookings/events');
  const eventCard = page.getByTestId('event-card').filter({ hasText: 'Мест: 1 из 30' });
  await expect(eventCard).toHaveCount(1);
  await eventCard.getByRole('button', { name: 'Назначить дежурных' }).click();
  await page.getByLabel(duty.name).check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Дежурные сохранены')).toBeVisible();
  expect((await sql<{ userId: string }[]>`SELECT user_id AS "userId" FROM event_duty WHERE event_id = ${eventB}`).map((r) => r.userId)).toEqual([duty.id]);

  await page.goto(`/bookings/consult-day?date=${grey!.bookingDate}`);
  const row = page.getByTestId('day-booking').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Назначить', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${consultant.name}`) }).click();
  await expect(page.getByText('Консультант назначен')).toBeVisible();
  const [assigned] = await sql<{ resourceId: string | null }[]>`SELECT resource_id AS "resourceId" FROM bookings WHERE id = ${grey!.id}`;
  expect(assigned?.resourceId).toBe(consultant.resourceId);

  // --- 7. мероприятие и встреча начались (сдвиг в БД на час назад) ---
  const started = startedAgo();
  await sql`UPDATE events SET event_date = ${started.date}, start_time = ${started.time}, starts_at = ${started.startsAt} WHERE id = ${eventB}`;
  await sql`UPDATE bookings SET booking_date = ${started.date}, start_time = ${started.time}, starts_at = ${started.startsAt}, updated_at = ${Date.now()}
            WHERE client_id = ${clientId} AND status IN ('registered', 'confirmed')`;

  // --- 8. дежурный отмечает явку ---
  await loginAs(page, duty.phone);
  await page.goto('/duty');
  await page.waitForURL(`**/duty/${eventB}`);
  const guestRow = page.getByTestId('guest-row');
  await expect(guestRow).toHaveCount(1);
  await guestRow.getByRole('button', { name: 'Пришёл', exact: true }).click();
  await expect(page.getByTestId('count-attended')).toHaveText('Пришли: 1');
  expect(await noHScroll(page)).toBe(true);
  const [attended] = await sql<{ status: string }[]>`SELECT status FROM bookings WHERE client_id = ${clientId} AND kind = 'group' AND status <> 'moved'`;
  expect(attended?.status).toBe('attended');

  // --- 9. консультант получает заявку и ставит итог встречи ---
  await loginAs(page, consultant.phone);
  await page.goto('/consultations');
  const mine = page.getByTestId('my-consultation').filter({ hasText: name });
  await expect(mine).toBeVisible();
  await mine.click();
  await page.waitForURL(`**/consultations/${grey!.id}`);
  await page.getByRole('button', { name: 'Пришёл', exact: true }).click();
  await expect(page.getByTestId('result-form')).toBeVisible();
  await page.getByLabel('Что обсудили').fill('Обсудили продвижение, синтетическая встреча');
  await page.getByLabel('Этап сделки').selectOption({ label: 'Переговоры / КП' });
  await page.getByLabel('Следующий шаг').selectOption({ label: 'Звонок' });
  await page.getByRole('button', { name: 'Сохранить итог' }).click();
  await expect(page.getByText('Итог сохранён')).toBeVisible();
  const [meeting] = await sql<{ status: string; stageKey: string }[]>`
    SELECT b.status, d.stage_key AS "stageKey" FROM bookings b JOIN deals d ON d.id = b.deal_id WHERE b.id = ${grey!.id}`;
  expect([meeting?.status, meeting?.stageKey]).toEqual(['attended', 'offer']);

  // --- 10. покупка в целых тенге, сделка выиграна, передача ждёт отдел ---
  await page.goto(`/deals/purchase/${cardId}`);
  await expect(page.getByRole('heading', { name: 'Покупка' })).toBeVisible();
  await page.getByLabel('Услуга').selectOption('smm');
  await page.getByLabel('Сумма, ₸').fill('450000');
  await expect(page.getByLabel('Сумма, ₸')).toHaveValue(/^450\s000$/);
  await page.getByRole('button', { name: 'Зарегистрировать' }).click();
  await page.waitForURL(`**/deals/${grey!.dealId}`);
  await expect(page.getByTestId('deal-amount')).toHaveText(/^450\s000 ₸$/);
  await expect(page.getByTestId('deal-handoff')).toHaveText('Ждёт отдел');
  expect(await noHScroll(page)).toBe(true);
  const [deal] = await sql<{ status: string; amount: string }[]>`SELECT status, amount_kzt::text AS amount FROM deals WHERE id = ${grey!.dealId}`;
  expect([deal?.status, deal?.amount]).toEqual(['won', '450000']);
  const [handoff] = await sql<{ id: string; status: string; teamId: string }[]>`SELECT id, status, team_id AS "teamId" FROM handoffs WHERE deal_id = ${grey!.dealId}`;
  expect([handoff?.status, handoff?.teamId]).toEqual(['pending', team!.id]);

  // --- 11. глава отдела принимает передачу ---
  await loginAs(page, head.phone);
  await page.goto('/handoffs');
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await page.waitForURL(`**/handoffs/${handoff!.id}`);
  await page.getByRole('button', { name: 'Принять' }).click();
  await expect(page.getByTestId('handoff-summary').getByText('Принята')).toBeVisible();
  expect((await sql<{ status: string }[]>`SELECT status FROM handoffs WHERE id = ${handoff!.id}`)[0]?.status).toBe('accepted');

  // --- 12. отчёт за период: строка оператора содержит звонок, ЛПР, записи, явки и покупку ---
  await loginAs(page, rop.phone);
  await page.goto('/reports?r=operators');
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`Оператор Пилот ${tag}`) }).filter({ hasText: /450\s000/ })).toHaveCount(1);
  expect(await noHScroll(page)).toBe(true);
  const report = await page.request.get('/api/reports/operators');
  expect(report.status()).toBe(200);
  const opRows = ((await report.json()) as { rows: Array<Record<string, number | string>> }).rows.filter((r) => r.userId === op.id && r.bucket === 'total');
  expect(opRows).toHaveLength(1);
  expect(opRows[0]).toMatchObject({ outcomes: 1, connects: 1, lpr: 1, groups: 1, consults: 1, attended: 2, noShow: 0, purchases: 1, purchaseSumKzt: 450_000 });

  // --- 13. панель директора: приращение недели = ровно наш звонок, записи, явки и покупка ---
  await loginAs(page, director.phone);
  await page.goto('/director');
  await expect(page.getByRole('heading', { name: 'Панель директора', level: 1 })).toBeVisible();
  const after = await directorNumbers(page);
  expect(after.calls.outcomes - before.calls.outcomes).toBe(1);
  expect(after.calls.connects - before.calls.connects).toBe(1);
  expect(after.bookings.groups - before.bookings.groups).toBeGreaterThanOrEqual(1);
  expect(after.bookings.consults - before.bookings.consults).toBe(1);
  expect(after.attendance.attended - before.attendance.attended).toBeGreaterThanOrEqual(1);
  expect(after.purchases.count - before.purchases.count).toBe(1);
  expect(after.purchases.sumKzt - before.purchases.sumKzt).toBe(450_000);
});

// --- Гейты дня 4 (PLAN: «e2e: 10 итогов без сети…; шторка восстанавливается после перезапуска PWA») ---

test('10 итогов не уходят на сервер → перезагрузка вкладки → сеть вернулась → 10 строк, без дублей', async ({ page, context }) => {
  // Очередь на странице держит 6 карточек (CallScreen DEPTH): 10 подряд при полном отсутствии сети поставить нельзя,
  // поэтому отправка итогов обрывается на сети (запрос не доходит), а очередь продолжает пополняться.
  const op = await makeOperator(12);
  await context.route('**/api/calls/outcomes', (route) => route.abort('internetdisconnected'));
  await openCall(page, op);
  for (let i = 0; i < 10; i++) {
    await expect(cardTitle(page)).toHaveText(op.names[i]!);
    await callAndOutcome(page, 'no_answer');
  }
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 10', { timeout: 20_000 });
  expect(await callsOf(op.id)).toHaveLength(0);

  // Перезагрузка вкладки: итоги лежат в IndexedDB, уже отработанные карточки в очередь не возвращаются
  await page.reload();
  await expect(cardTitle(page)).toHaveText(op.names[10]!);
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 10', { timeout: 20_000 });
  const stored = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('crm-call');
        req.onsuccess = () => {
          const all = req.result.transaction('outbox').objectStore('outbox').getAll();
          all.onsuccess = () => resolve(all.result.length);
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  expect(stored).toBe(10);
  expect(await callsOf(op.id)).toHaveLength(0);

  // Сеть вернулась: ровно 10 строк, у каждой свой ключ операции и своя карточка
  await context.unroute('**/api/calls/outcomes');
  await page.goto('/call');
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 60_000 }).toBe(10);
  await expect(page.getByTestId('outbox-banner')).toBeHidden({ timeout: 20_000 });
  const rows = await callsOf(op.id);
  expect(new Set(rows.map((r) => r.id)).size).toBe(10);
  expect(rows.map((r) => r.cardId).sort()).toEqual(op.cardIds.slice(0, 10).sort());
  expect(rows.every((r) => r.applied === 'applied' && r.outcome === 'no_answer')).toBe(true);
  const feed = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'call' AND actor_id = ${op.id}`;
  expect(feed[0]!.n).toBe(10);

  // Ещё одна перезагрузка: повторной отправки нет
  await page.reload();
  await expect(page.getByTestId('call-card')).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(await callsOf(op.id)).toHaveLength(10);
});

test('без сети очередь страницы кончается на 6 карточках: «Нет сети, итоги сохранены», после возврата сети 6 строк', async ({ page, context }) => {
  const op = await makeOperator(8);
  await openCall(page, op);
  await context.setOffline(true);
  for (let i = 0; i < 6; i++) {
    await expect(cardTitle(page)).toHaveText(op.names[i]!);
    await callAndOutcome(page, 'no_answer');
  }
  await expect(page.getByText('Нет сети, итоги сохранены')).toBeVisible();
  await expect(page.getByTestId('outbox-banner')).toContainText('Не отправлено: 6', { timeout: 20_000 });
  // Вкладку выгрузили и открыли заново без сети: итоги на месте
  await page.reload();
  await expect(page.getByText('Нет сети, итоги сохранены')).toBeVisible();
  await context.setOffline(false);
  await page.goto('/call');
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 60_000 }).toBe(6);
  expect(new Set((await callsOf(op.id)).map((r) => r.id)).size).toBe(6);
});

test('шторка и отмеченное в ней восстанавливаются после перезапуска PWA (новая вкладка вместо закрытой)', async ({ page, context }) => {
  const op = await makeOperator(3);
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();
  await expect(page.getByTestId('outcome-callback')).toHaveAttribute('aria-pressed', 'true');

  // Перезапуск: вкладку закрыли совсем, приложение открыли заново (localStorage и cookie остались)
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/call');
  await expect(reopened.getByTestId('outcome-sheet')).toBeVisible();
  await expect(reopened.getByRole('dialog')).toContainText(op.names[0]!);
  await expect(reopened.getByTestId('lpr-yes')).toHaveAttribute('aria-pressed', 'true');
  await expect(reopened.getByTestId('outcome-callback')).toHaveAttribute('aria-pressed', 'true');
  expect(await callsOf(op.id)).toHaveLength(0);

  // Дозаполнили и сохранили — итог ушёл ровно один раз
  await pickCallbackTerm(reopened);
  await reopened.getByTestId('sheet-save').click();
  await expect.poll(async () => (await callsOf(op.id)).length, { timeout: 20_000 }).toBe(1);
  const [row] = await callsOf(op.id);
  expect(row).toMatchObject({ cardId: op.cardIds[0], outcome: 'callback', applied: 'applied' });
});
