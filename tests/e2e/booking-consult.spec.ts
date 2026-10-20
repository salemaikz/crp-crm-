// Консультации (B5): оператор записывает клиента к консультанту по подбору, консультант на телефоне ведёт встречу —
// «Мои консультации» → «Пришёл» → итог с шагом и этапом «Переговоры / КП». Только синтетика (+7 709 …).
// БД — E2E_DATABASE_URL (та же, что у запущенного сервера); сервер запущен с FEATURE_BK_WIZARD=1 (playwright.config.ts).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql } from './support/calling';
import { makeConsultant, pretty } from './support/consult';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(() => prepareDb());

test('оператор записывает к консультанту, консультант отмечает явку и пишет итог', async ({ page, context }) => {
  const spaceId = (await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`)[0]!.id;
  const consultant = await makeConsultant({ exclusive: true });
  const op = await makeOperator(2);
  const [cardA, cardB] = op.cardIds as [string, string];
  const [clientA, clientB] = op.clientIds as [string, string];
  const [, nameB] = op.names as [string, string];
  await sql`UPDATE cards SET state = 'agreed' WHERE id = ANY(${op.cardIds})`;

  // --- оператор: БК → «Маркетинг» → день → время → «Записать к …» → «Подтвердить» ---
  await login(page, op);
  await page.goto(`/bookings/new/${cardA}`);
  await page.getByRole('tab', { name: 'БК' }).click();
  await page.getByRole('button', { name: 'Маркетинг' }).click();
  await page.getByRole('group', { name: 'День' }).getByRole('button').first().click();
  await page.getByRole('group', { name: 'Время' }).getByRole('button').first().click();
  expect(await noHScroll(page)).toBe(true);
  await page.getByRole('button', { name: new RegExp(`^Записать к ${consultant.name}`) }).click();
  await expect(page.getByText(new RegExp(`к консультанту ${consultant.name}\\?$`))).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(new RegExp(`^Записан: БК, .*${consultant.name}`)).first()).toBeVisible();
  const [booked] = await sql<{ resourceId: string | null; isReserve: boolean; directionKey: string }[]>`
    SELECT resource_id AS "resourceId", is_reserve AS "isReserve", direction_key AS "directionKey" FROM bookings WHERE client_id = ${clientA}`;
  expect([booked?.resourceId, booked?.isReserve, booked?.directionKey]).toEqual([consultant.resourceId, false, 'marketing']);

  // --- встреча, которая началась: второй клиент оператора, сделка на этапе «Записан» ---
  const t = Date.now();
  const localMidnight = Math.floor((t + 5 * 3_600_000) / 86_400_000) * 86_400_000 - 5 * 3_600_000;
  const startsAt = Math.max(t - 3_600_000, localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  const dealId = randomUUID();
  const bookingId = randomUUID();
  await sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, version, created_by, created_at, updated_at)
    VALUES (${dealId}, ${spaceId}, 'sales', 'booked', 'open', ${clientB}, ${cardB}, ${op.id}, ${t}, 0, ${op.id}, ${t}, ${t})`;
  await sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, direction_key,
                          status, booked_by_user_id, responsible_user_id, version, created_at, updated_at)
    VALUES (${bookingId}, ${spaceId}, 'individual', 'bk', ${consultant.resourceId}, ${clientB}, ${cardB}, ${dealId}, ${stamp.slice(0, 10)}, ${stamp.slice(11, 16)}, ${startsAt}, 45,
            'marketing', 'registered', ${op.id}, ${op.id}, 0, ${t}, ${t})`;

  // --- консультант: «Мои консультации» → встреча → «Пришёл» → итог ---
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(consultant.phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');

  await page.goto('/consultations');
  await expect(page.getByRole('heading', { name: 'Мои консультации' })).toBeVisible();
  const card = page.getByTestId('my-consultation').filter({ hasText: nameB });
  await expect(card).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  await card.click();
  await page.waitForURL(`**/consultations/${bookingId}`);
  await expect(page.getByRole('heading', { name: nameB })).toBeVisible();

  await page.getByRole('button', { name: 'Пришёл', exact: true }).click();
  await expect(page.getByTestId('result-form')).toBeVisible();
  await page.getByLabel('Что обсудили').fill('Показали услуги по маркетингу');
  await page.getByLabel('Следующий шаг').selectOption({ label: 'Звонок' });
  await page.getByLabel('Этап сделки').selectOption({ label: 'Переговоры / КП' });
  expect(await noHScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Сохранить итог' }).click();
  await expect(page.getByText('Итог сохранён')).toBeVisible();

  const [b] = await sql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${bookingId}`;
  const [deal] = await sql<{ stageKey: string }[]>`SELECT stage_key AS "stageKey" FROM deals WHERE id = ${dealId}`;
  const notes = await sql<{ body: string; authorId: string }[]>`SELECT body, author_id AS "authorId" FROM notes WHERE client_id = ${clientB}`;
  const tasks = await sql<{ kind: string; assignee: string }[]>`SELECT kind, assignee_user_id AS assignee FROM tasks WHERE deal_id = ${dealId} AND source = 'manual'`;
  expect(b?.status).toBe('attended');
  expect(deal?.stageKey).toBe('offer');
  expect(notes.map((n) => [n.body, n.authorId])).toEqual([['Показали услуги по маркетингу', consultant.userId]]);
  expect(tasks.map((x) => [x.kind, x.assignee])).toEqual([['call', consultant.userId]]);
});
