// Доска РОП и директора на общем компоненте (pipeline-v2 §11, линия M1): фильтры по признакам и сотруднику, перенос РОП
// итогом manual_entry онлайн, директор без переноса (423). Нужен запуск с FEATURE_OP_BOARD=1 FEATURE_CALLBACK_V2=1 (стенд).
// Синтетика: номера +7 709 …, названия «ТОО Синтетика …».
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, callsOf, login, makeOperator, prepareDb, sql, type Operator } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(process.env.FEATURE_OP_BOARD !== '1' || process.env.FEATURE_CALLBACK_V2 !== '1', 'нужен запуск с FEATURE_OP_BOARD=1 и FEATURE_CALLBACK_V2=1 (стенд)');

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

test.beforeAll(() => {
  prepareDb();
});

const tileOf = (page: Page, name: string) => page.getByTestId('lead-tile').filter({ hasText: name });

async function staff(role: string, name: string): Promise<Operator> {
  const op = await makeOperator(0, { role });
  await sql`UPDATE users SET name = ${name} WHERE id = ${op.id}`;
  return op;
}

async function loginAs(page: Page, who: Operator): Promise<void> {
  await login(page, who);
  await page.goto('/deals/calling');
  await expect(page.getByTestId('board-screen')).toBeVisible();
  await expect(page.getByTestId('board-manager-filters')).toBeVisible();
}

test('РОП фильтрует «не пришёл» и сотрудника, переносит карточку в «Перезвон» итогом manual_entry', async ({ page }) => {
  const rop = await staff('rop', 'РОП Синтетик');
  const op = await makeOperator(2);
  await sql`UPDATE users SET name = ${'Оператор Доска ' + op.id.slice(0, 4)} WHERE id = ${op.id}`;
  // у первой карточки неявка
  await sql`UPDATE cards SET last_no_show_at = ${Date.now() - 3_600_000} WHERE id = ${op.cardIds[0]!}`;

  await loginAs(page, rop);
  await page.getByTestId('filter-owner').selectOption(op.id);
  await expect(tileOf(page, op.names[0]!)).toBeVisible();
  await expect(tileOf(page, op.names[1]!)).toBeVisible();

  await page.getByTestId('filter-noShow').click();
  await expect(tileOf(page, op.names[0]!)).toBeVisible();
  await expect(tileOf(page, op.names[1]!)).toHaveCount(0);
  await page.getByTestId('filter-noShow').click();
  await expect(tileOf(page, op.names[1]!)).toBeVisible();

  await page.getByTestId('filter-owner').selectOption(op.id);
  const tile = tileOf(page, op.names[1]!);
  await tile.getByTestId('tile-menu').click();
  await page.getByTestId('move-to-callback').click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('lpr-yes').click();
  await page.getByTestId('outcome-callback').click();
  await page.getByTestId('outcome-details').getByRole('button', { name: 'Подумает' }).click();
  await page.getByTestId('callback-hint').click();
  await page.getByTestId('sheet-save').click();
  await expect(sheet).toBeHidden();

  // итог внесён онлайн сразу, от имени РОП, с каналом manual_entry
  await expect.poll(async () => (await callsOf(rop.id)).length, { timeout: 15_000 }).toBe(1);
  expect((await callsOf(rop.id))[0]!.via).toBe('manual_entry');
  const [row] = await sql<{ state: string; owner: string }[]>`SELECT state, owner_user_id AS owner FROM cards WHERE id = ${op.cardIds[1]!}`;
  expect(row).toEqual({ state: 'callback', owner: op.id });
  await expect(page.getByTestId('column-callback').getByTestId('lead-tile').filter({ hasText: op.names[1]! })).toBeVisible();
});

test('директор видит доску без переноса, а мутация даёт 423', async ({ page }) => {
  const director = await staff('director', 'Директор Синтетик');
  const op = await makeOperator(1);
  await loginAs(page, director);
  // В общей базе копятся карточки прошлых прогонов, а колонка показывает первые: сужаем доску до оператора этого прогона
  await page.getByTestId('filter-owner').selectOption(op.id);
  await expect(tileOf(page, op.names[0]!)).toBeVisible();
  // цели переноса не предлагаются
  await expect(page.getByTestId('tile-menu')).toHaveCount(0);

  const res = await page.request.post('/api/calls/outcomes', {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { opId: randomUUID(), cardId: op.cardIds[0]!, via: 'manual_entry', kind: 'callback' },
  });
  expect(res.status()).toBe(423);
});

test('оператору страница «Обзвон» недоступна', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);
  const res = await page.goto('/deals/calling');
  expect([403, 404]).toContain(res?.status());
});

