// Покупка (B6): консультант на телефоне регистрирует покупку услуги с передачей в отдел — двойное нажатие даёт одну
// сделку; РОП на странице сделки правит сумму и отменяет покупку «ошибкой ввода» — сделка возвращается на прежний этап.
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у запущенного сервера); сервер с FEATURE_PURCHASES=1.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, makeOperator, prepareDb, sql } from './support/calling';
import { makeConsultant, pretty } from './support/consult';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(() => prepareDb());

async function loginAs(page: Page, phone: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

test('консультант: покупка с передачей, двойное нажатие — одна сделка; РОП правит сумму и отменяет покупку', async ({ page }) => {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const spaceId = space!.id;
  const consultant = await makeConsultant();
  const op = await makeOperator(1);
  const [cardId] = op.cardIds as [string];
  const [clientId] = op.clientIds as [string];
  const [name] = op.names as [string];
  await sql`UPDATE cards SET state = 'agreed' WHERE id = ${cardId}`;

  // встреча консультанта завтра (окно открыто) и сделка на этапе «Переговоры / КП»
  const t = Date.now();
  const tomorrow = new Date(t + 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  const dealId = randomUUID();
  await sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, version, created_by, created_at, updated_at)
    VALUES (${dealId}, ${spaceId}, 'sales', 'offer', 'open', ${clientId}, ${cardId}, ${op.id}, ${t}, 0, ${op.id}, ${t}, ${t})`;
  await sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, direction_key,
                          status, booked_by_user_id, responsible_user_id, version, created_at, updated_at)
    VALUES (${randomUUID()}, ${spaceId}, 'individual', 'bk', ${consultant.resourceId}, ${clientId}, ${cardId}, ${dealId}, ${tomorrow}, '11:00', ${t + 86_400_000}, 45,
            'marketing', 'registered', ${op.id}, ${op.id}, 0, ${t}, ${t})`;

  // --- консультант: форма покупки ---
  await loginAs(page, consultant.phone);
  await page.goto(`/deals/purchase/${cardId}`);
  await expect(page.getByRole('heading', { name: 'Покупка' })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByLabel('Сделка')).toHaveValue(dealId);
  await page.getByLabel('Услуга').selectOption('smm');
  await page.getByLabel('Сумма, ₸').fill('450000');
  await expect(page.getByLabel('Сумма, ₸')).toHaveValue(/^450\s000$/);
  expect(await noHScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Зарегистрировать' }).dblclick();
  await page.waitForURL(`**/deals/${dealId}`);
  await expect(page.getByTestId('deal-amount')).toHaveText(/^450\s000 ₸$/);
  await expect(page.getByTestId('deal-handoff')).toHaveText('Ждёт отдел');
  expect(await noHScroll(page)).toBe(true);

  const deals = await sql<{ id: string; status: string; amount: string }[]>`SELECT id, status, amount_kzt::text AS amount FROM deals WHERE card_id = ${cardId}`;
  expect(deals.map((d) => [d.id, d.status, d.amount])).toEqual([[dealId, 'won', '450000']]);
  const won = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_events WHERE deal_id = ${dealId} AND kind = 'deal.won'`;
  expect(won[0]?.n).toBe(1);
  const [card] = await sql<{ state: string }[]>`SELECT state FROM cards WHERE id = ${cardId}`;
  expect(card?.state).toBe('client');

  // --- РОП: правка суммы и отмена покупки «ошибкой ввода» ---
  const ropId = randomUUID();
  const ropPhone = `7709${digits(7)}`;
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${ropId}, ${ropPhone}, 'РОП Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${ropId}, ${spaceId}, 'rop', FALSE, ${t}, ${t})`;
  await loginAs(page, ropPhone);
  await page.goto(`/deals/${dealId}`);
  await page.getByRole('button', { name: 'Изменить сумму' }).click();
  await page.getByLabel('Сумма, ₸').fill('400000');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('deal-amount')).toHaveText(/^400\s000 ₸$/);

  await page.getByRole('button', { name: 'Отменить покупку' }).click();
  await page.getByRole('button', { name: 'Ошибка ввода' }).click();
  await page.getByLabel('Комментарий').fill('Покупку внесли по ошибке');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByTestId('deal-summary').getByText('В работе')).toBeVisible();
  const [after] = await sql<{ status: string; stageKey: string; amount: string }[]>`SELECT status, stage_key AS "stageKey", amount_kzt::text AS amount FROM deals WHERE id = ${dealId}`;
  expect([after?.status, after?.stageKey, after?.amount]).toEqual(['open', 'offer', '0']);
  const [ho] = await sql<{ status: string }[]>`SELECT status FROM handoffs WHERE deal_id = ${dealId}`;
  expect(ho?.status).toBe('cancelled');
});
