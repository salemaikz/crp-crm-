// C8 на телефоне оператора: итоговый блок, заметка и закрепление, история правок, история сделки, «Записать» → мастер.
// Нужна БД e2e (E2E_DATABASE_URL). Только синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DB_URL, login, makeOperator, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

test.beforeAll(() => {
  prepareDb();
});

/** Липкая кнопка «Позвонить» внизу экрана перекрывает нижний край и сбивает проверку попадания: нажимаем самим элементом. */
async function tap(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.evaluate((el) => (el as HTMLElement).click());
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('карточка клиента: итог, заметка с закреплением, история правок и сделки, «Записать» ведёт в мастер', async ({ page }) => {
  const op = await makeOperator(1);
  const cardId = op.cardIds[0]!;
  const clientId = op.clientIds[0]!;
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const t = Date.now();
  await sql`UPDATE cards SET state = 'agreed' WHERE id = ${cardId}`;
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt,
                               won_at, stage_changed_at, created_by, created_at, updated_at)
            VALUES (${randomUUID()}, ${space!.id}, 'sales', 'won', 'won', ${clientId}, ${cardId}, ${op.id}, 'smm', 450000, ${t - 60_000}, ${t}, ${op.id}, ${t - 120_000}, ${t})`;
  const dealId = (await sql<{ id: string }[]>`SELECT id FROM deals WHERE client_id = ${clientId}`)[0]!.id;
  await sql`INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, data)
            VALUES (${randomUUID()}, ${clientId}, ${space!.id}, ${dealId}, 'deal.created', ${op.id}, ${t - 100_000}, '{}'::jsonb)`;
  await sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data)
            VALUES (${randomUUID()}, ${clientId}, ${space!.id}, 'field.changed', ${op.id}, ${t - 90_000},
                    '{"obj":"client","sys":true,"field":"region","before":null,"after":"Астана"}'::jsonb)`;
  await sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data)
            VALUES (${randomUUID()}, ${clientId}, ${space!.id}, 'call', ${op.id}, ${t - 80_000}, '{}'::jsonb)`;

  await login(page, op);
  await page.goto(`/clients/${clientId}`);
  expect(await noHorizontalScroll(page)).toBe(true);

  // Итоговый блок: структура → фразы из локали
  const summary = page.getByTestId('client-summary');
  await expect(summary).toContainText('Звонков пока не было.');
  await expect(summary).toContainText('Покупка «');
  await expect(summary).toContainText('450');
  await expect(summary).toContainText('Владелец: Оператор Синтетик.');
  await expect(summary).toContainText('Следующий шаг: нет.');

  // Заметка: добавляется, текст в ленте; закрепляется и попадает в закреплённые
  await page.getByLabel('Новая заметка').fill('Просили КП до пятницы');
  await tap(page.getByRole('button', { name: 'Добавить заметку' }));
  const feedNote = page.getByTestId('feed-note').filter({ hasText: 'Просили КП до пятницы' });
  await expect(feedNote).toBeVisible();
  await tap(page.getByRole('button', { name: 'Закрепить' }).first());
  await expect(page.getByTestId('pinned-note').filter({ hasText: 'Просили КП до пятницы' })).toBeVisible();
  const [pinned] = await sql<{ pinned: boolean }[]>`SELECT pinned FROM notes WHERE client_id = ${clientId} AND body = 'Просили КП до пятницы'`;
  expect(pinned?.pinned).toBe(true);

  // История правок: только правка поля, без звонка и заметки
  await tap(page.getByRole('button', { name: 'История правок' }));
  await expect(page.getByText('Изменено «Регион»')).toBeVisible();
  await expect(page.getByTestId('feed-note')).toHaveCount(0);
  await tap(page.getByRole('button', { name: 'Всё', exact: true }));

  // История сделки: лента сужается до её событий
  await expect(page.getByTestId('deal-row')).toHaveCount(1);
  await expect(page.getByTestId('deal-row')).toContainText('Выиграна');
  await tap(page.getByRole('button', { name: 'История сделки' }));
  await expect(page.getByText('Только события выбранной сделки')).toBeVisible();
  await expect(page.getByText('Создана сделка')).toBeVisible();
  await expect(page.getByText('Звонок', { exact: true })).toHaveCount(0);
  await tap(page.getByRole('button', { name: 'Показать всю историю' }).first());

  // «Записать» → мастер записи этой карточки
  await tap(page.getByRole('link', { name: 'Записать' }));
  await page.waitForURL(`**/bookings/new/${cardId}`);
});

test('карточка не «Договорились»: кнопки «Записать» нет', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto(`/clients/${op.clientIds[0]!}`);
  await expect(page.getByRole('heading', { name: 'Итог по клиенту' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Записать' })).toHaveCount(0);
});
