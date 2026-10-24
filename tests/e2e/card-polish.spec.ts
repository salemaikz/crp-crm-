// Карточка клиента после доработки круга 2 (линия card): «← К доске», шапка от доски, звонок в ленте, один список
// номеров с контактом, «Покупка». Нужна БД e2e (E2E_DATABASE_URL); сценарии доски идут с FEATURE_OP_BOARD=1
// и FEATURE_CALLBACK_V2=1. Только синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { CALLBACK_V2, DB_URL, OP_BOARD, login, makeOperator, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

const DAY = 86_400_000;
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function spaceId(): Promise<string> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  return space!.id;
}

test('«← К доске»: возврат на вкладку; чужой from и мусорная вкладка не дают открытого редиректа', async ({ page }) => {
  test.skip(!OP_BOARD, 'нужен FEATURE_OP_BOARD=1');
  const op = await makeOperator(1);
  await login(page, op);
  const id = op.clientIds[0]!;

  await page.goto(`/clients/${id}?from=board&tab=callback`);
  const back = page.getByRole('link', { name: 'К доске' });
  await expect(back).toHaveAttribute('href', '/board?tab=callback');
  await back.click();
  await page.waitForURL('**/board?tab=callback');

  await page.goto(`/clients/${id}?from=board&tab=${encodeURIComponent('https://evil.example')}`);
  await expect(page.getByRole('link', { name: 'К доске' })).toHaveAttribute('href', '/board');

  await page.goto(`/clients/${id}?from=${encodeURIComponent('//evil.example')}&tab=callback`);
  await expect(page.getByRole('link', { name: 'К списку клиентов' })).toHaveAttribute('href', '/clients');
  await expect(page.getByRole('link', { name: 'К доске' })).toHaveCount(0);
});

test('шапка перезвона «на день»: колонка, причина с касанием, явка, срок без времени; звонок в ленте с заметкой', async ({ page }) => {
  test.skip(!OP_BOARD || !CALLBACK_V2, 'нужны FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1');
  const op = await makeOperator(1);
  const cardId = op.cardIds[0]!;
  const clientId = op.clientIds[0]!;
  const sp = await spaceId();
  const t = Date.now();
  const due = t + 3 * DAY;
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${due}, next_call_precision = 'day', callback_reason = 'think', callback_touches = 2,
                   attended_group_at = ${t - DAY} WHERE id = ${cardId}`;
  const callId = randomUUID();
  await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, reason_code, note, callback_at, callback_precision,
                               applied, occurred_at, received_at, duration_sec, config_rev)
            VALUES (${callId}, ${sp}, ${cardId}, ${clientId}, ${op.id}, 'ui', ${op.phone}, 'callback', 'callback', 'think', ${'Директор просил набрать в понедельник'}, ${due}, 'day',
                    'applied', ${t - 60_000}, ${t - 60_000}, 95, 1)`;
  await sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
            VALUES (${randomUUID()}, ${clientId}, ${sp}, 'call', ${op.id}, ${t - 60_000}, 'call', ${callId}, '{"outcome":"callback","durationSec":95}'::jsonb)`;

  await login(page, op);
  await page.goto(`/clients/${clientId}`);
  expect(await noHorizontalScroll(page)).toBe(true);

  await expect(page.getByTestId('head-state')).toHaveText('Перезвон');
  await expect(page.getByTestId('head-reason')).toHaveText('Подумает · касание 2');
  await expect(page.getByTestId('head-attended-group')).toContainText('Был на БР');
  const lead = page.locator('.k-page-header__lead');
  await expect(lead).toContainText('в течение дня');
  expect(await lead.innerText()).not.toMatch(/\d{2}:\d{2}/);

  // Итог по клиенту: тоже без времени
  await expect(page.getByTestId('client-summary')).toContainText('в течение дня');

  // Лента: «Звонок · итог · причина → перезвон срок», длительность и текст заметки звонка
  const feed = page.getByRole('region', { name: 'История' }).or(page.locator('#client-feed-title').locator('..'));
  await expect(feed).toContainText(/Звонок · Перезвонить · Подумает → перезвон \S{2} \d{2}\.\d{2} · 1 мин 35 с/);
  await expect(page.getByTestId('feed-call-note')).toHaveText('Директор просил набрать в понедельник');
});

test('номера одним списком: номер контакта подписан контактом, новый контакт создаётся с телефоном', async ({ page }) => {
  const op = await makeOperator(1, { lpr: true });
  await login(page, op);
  await page.goto(`/clients/${op.clientIds[0]!}`);
  const phones = page.locator('#client-phones-title').locator('xpath=ancestor::section[1]');
  // Один список: номер ЛПР подписан контактом, действий отдельным вторым списком нет
  await expect(phones.getByRole('listitem')).toHaveCount(2);
  await expect(phones).toContainText('Асель Синтетик');
  await expect(phones.getByRole('button', { name: 'Сделать основным' })).toHaveCount(0);
  // «⋯» открывает действия над номером
  await phones.getByTestId('phone-more').nth(1).click();
  await expect(page.getByRole('button', { name: 'Сделать основным' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Новый контакт с телефоном: номер появляется в списке и подписан этим контактом
  await page.getByRole('button', { name: 'Добавить контакт' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('Бахыт Синтетик');
  await page.getByLabel('Телефон').fill('+7 709 555 01 77');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(phones.getByRole('listitem')).toHaveCount(3);
  await expect(phones.getByRole('listitem').filter({ hasText: '+7 709 555 01 77' })).toContainText('Бахыт Синтетик');
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('«Покупка» у РОП по открытой сделке; «Полный отказ» спрятан в «Другие действия»', async ({ page }) => {
  const rop = await makeOperator(1, { role: 'rop' });
  const cardId = rop.cardIds[0]!;
  const clientId = rop.clientIds[0]!;
  const sp = await spaceId();
  const t = Date.now();
  await sql`UPDATE cards SET state = 'client' WHERE id = ${cardId}`;
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_by, created_at, updated_at)
            VALUES (${randomUUID()}, ${sp}, 'sales', 'booked', 'open', ${clientId}, ${cardId}, ${rop.id}, ${t}, ${rop.id}, ${t}, ${t})`;
  await login(page, rop);
  await page.goto(`/clients/${clientId}`);
  const buy = page.getByTestId('card-purchase');
  await expect(buy).toHaveAttribute('href', `/deals/purchase/${cardId}`);
  await expect(page.getByRole('button', { name: 'Полный отказ' })).toBeHidden();
  await page.getByText('Другие действия').click();
  await expect(page.getByRole('button', { name: 'Полный отказ' })).toBeVisible();
  await buy.click();
  await page.waitForURL(`**/deals/purchase/${cardId}`);
});

test('оператор: кнопки «Покупка» нет', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto(`/clients/${op.clientIds[0]!}`);
  await expect(page.getByRole('heading', { name: 'Итог по клиенту' })).toBeVisible();
  await expect(page.getByTestId('card-purchase')).toHaveCount(0);
});
