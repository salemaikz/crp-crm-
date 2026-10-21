// Входящие передачи (B6b): глава отдела с телефона — «Передачи» → «Принять» → «Назначить исполнителя»;
// исполнитель видит передачу без кнопок; отклонение требует причину. Только синтетика (+7 709 …).
// БД — E2E_DATABASE_URL (та же, что у запущенного сервера); сервер с FEATURE_PURCHASES=1.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, makeOperator, prepareDb, sql } from './support/calling';
import { pretty } from './support/consult';

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

async function makeStaff(spaceId: string, roleKey: string, name: string, teamId: string | null): Promise<{ id: string; phone: string }> {
  const t = Date.now();
  const id = randomUUID();
  const phone = `7709${digits(7)}`;
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at) VALUES (${id}, ${spaceId}, ${roleKey}, ${teamId}, FALSE, ${t}, ${t})`;
  return { id, phone };
}

/** Выигранная сделка клиента оператора и ждущая передача отделу `marketing`. */
async function seedHandoff(spaceId: string, teamId: string): Promise<{ handoffId: string; clientName: string; clientId: string }> {
  const op = await makeOperator(1);
  const [cardId] = op.cardIds as [string];
  const [clientId] = op.clientIds as [string];
  const [clientName] = op.names as [string];
  const t = Date.now();
  const dealId = randomUUID();
  const handoffId = randomUUID();
  await sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, stage_changed_at, version,
                       created_by, created_at, updated_at)
    VALUES (${dealId}, ${spaceId}, 'sales', 'paid', 'won', ${clientId}, ${cardId}, ${op.id}, 'smm', 450000, ${t}, ${t}, 0, ${op.id}, ${t}, ${t})`;
  await sql`
    INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, due_at, created_at)
    VALUES (${handoffId}, ${spaceId}, ${spaceId}, ${teamId}, ${dealId}, ${clientId}, 'pending', ${t + 86_400_000}, ${t})`;
  return { handoffId, clientName, clientId };
}

test('глава отдела принимает и назначает исполнителя; исполнитель видит без кнопок', async ({ page }) => {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const spaceId = space!.id;
  const [team] = await sql<{ id: string }[]>`SELECT id FROM teams WHERE space_id = ${spaceId} AND key = 'marketing' AND archived_at IS NULL`;
  const head = await makeStaff(spaceId, 'marketing_head', 'Руководитель Синтетик', team!.id);
  // имя уникально: в общей e2e-базе от прошлых прогонов остаются другие сотрудники отдела
  const marketerName = `Маркетолог Синтетик ${digits(5)}`;
  const marketer = await makeStaff(spaceId, 'marketer', marketerName, team!.id);
  await sql`UPDATE teams SET lead_user_id = ${head.id} WHERE id = ${team!.id}`;
  const { handoffId, clientName } = await seedHandoff(spaceId, team!.id);

  await loginAs(page, head.phone);
  await page.goto('/handoffs');
  await expect(page.getByRole('heading', { name: 'Передачи' })).toBeVisible();
  const row = page.getByRole('link', { name: new RegExp(clientName) });
  await expect(row).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  await row.click();
  await page.waitForURL(`**/handoffs/${handoffId}`);

  // отклонение без причины недоступно
  await page.getByRole('button', { name: 'Отклонить' }).click();
  await expect(page.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
  await page.getByRole('button', { name: 'Закрыть' }).first().click();

  // принять
  await page.getByRole('button', { name: 'Принять' }).click();
  await expect(page.getByTestId('handoff-summary').getByText('Принята')).toBeVisible();
  const [accepted] = await sql<{ status: string }[]>`SELECT status FROM handoffs WHERE id = ${handoffId}`;
  expect(accepted?.status).toBe('accepted');

  // назначить исполнителя
  await page.getByRole('button', { name: 'Назначить исполнителя' }).click();
  await page.getByRole('button', { name: marketerName }).click();
  await expect(page.getByTestId('handoff-assignee')).toHaveText(marketerName);
  const [assigned] = await sql<{ assignee: string }[]>`SELECT assignee_user_id AS assignee FROM handoffs WHERE id = ${handoffId}`;
  expect(assigned?.assignee).toBe(marketer.id);
  const tasks = await sql<{ assignee: string }[]>`SELECT assignee_user_id AS assignee FROM tasks WHERE source_key = ${`handoff_work:${handoffId}`} AND status = 'open'`;
  expect(tasks.map((x) => x.assignee)).toEqual([marketer.id]);

  // исполнитель: передача видна, кнопок нет
  await loginAs(page, marketer.phone);
  await page.goto(`/handoffs/${handoffId}`);
  await expect(page.getByTestId('handoff-summary')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Принять' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Назначить исполнителя' })).toHaveCount(0);
  expect(await noHScroll(page)).toBe(true);
});

test('глава отклоняет передачу с причиной — у главы страница передачи становится 404', async ({ page }) => {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const spaceId = space!.id;
  const [team] = await sql<{ id: string }[]>`SELECT id FROM teams WHERE space_id = ${spaceId} AND key = 'marketing' AND archived_at IS NULL`;
  const head = await makeStaff(spaceId, 'marketing_head', 'Руководитель Синтетик Два', team!.id);
  await sql`UPDATE teams SET lead_user_id = ${head.id} WHERE id = ${team!.id}`;
  const { handoffId } = await seedHandoff(spaceId, team!.id);

  await loginAs(page, head.phone);
  await page.goto(`/handoffs/${handoffId}`);
  await page.getByRole('button', { name: 'Отклонить' }).click();
  await page.getByLabel('Почему отклоняете').fill('Синтетическая причина отказа');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(async () => (await sql<{ status: string }[]>`SELECT status FROM handoffs WHERE id = ${handoffId}`)[0]?.status).toBe('declined');
  const res = await page.goto(`/handoffs/${handoffId}`);
  expect(res?.status()).toBe(404);
});
