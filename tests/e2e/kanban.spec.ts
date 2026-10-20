// Доски РОП на телефоне (B8, D-266): «Переместить в…», отложенная отправка 5 с с «Отменить», панель недостающего,
// вид «Обзвон» (перенос = итог с via manual_entry). Данные создаются прямо в БД приложения (E2E_DATABASE_URL);
// без неё тесты пропускаются. Маршрут переноса сделок (B6) подменён: проверяется то, что доска отправляет.
// Синтетика: номера 709 xxx xx xx (код не выдан ни одному оператору), компании выдуманные.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as never);
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const phone = () => `7709555${String(Math.floor(Math.random() * 9000) + 1000)}`;

type Staff = { id: string; phone: string; name: string };
let spaceId = '';
let rop: Staff;
let operator: Staff;
const tag = Math.floor(Math.random() * 90000) + 10000;
const ids = { backDeal: randomUUID(), forwardDeal: randomUUID(), card: randomUUID() };
const NAME = {
  back: `ТОО Синтетика Доска ${tag} Назад`,
  forward: `ТОО Синтетика Доска ${tag} Вперёд`,
  call: `ТОО Синтетика Доска ${tag} Обзвон`,
};

async function makeStaff(role: string, name: string, inDistribution = false): Promise<Staff> {
  const s = { id: randomUUID(), phone: phone(), name };
  const now = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${s.id}, ${s.phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${now})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${s.id}, ${spaceId}, ${role}, ${inDistribution}, ${now}, ${now})`;
  return s;
}

async function login(page: Page, s: Staff): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(s.phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function seedClient(name: string, owner: Staff): Promise<{ clientId: string; cardId: string; phoneId: string }> {
  const now = Date.now();
  const clientId = randomUUID();
  const cardId = randomUUID();
  const phoneId = randomUUID();
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', ${name}, ${name.toLowerCase()}, ${name.toLowerCase()}, 'import', ${now}, ${now})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
            VALUES (${phoneId}, ${clientId}, ${phone()}, 'mobile', TRUE, ${now})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, attempts, assigned_at, created_at, updated_at)
            VALUES (${cardId}, ${spaceId}, ${clientId}, ${owner.id}, 'retry', 1, ${now}, ${now}, ${now})`;
  return { clientId, cardId, phoneId };
}

async function seedDeal(id: string, stageKey: string, name: string, owner: Staff): Promise<void> {
  const { clientId, cardId } = await seedClient(name, owner);
  const now = Date.now();
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_by, created_at, updated_at)
            VALUES (${id}, ${spaceId}, 'sales', ${stageKey}, 'open', ${clientId}, ${cardId}, ${owner.id}, ${now - 3_600_000}, ${owner.id}, ${now}, ${now})`;
}

test.beforeAll(async () => {
  const space = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE is_default LIMIT 1`;
  spaceId = space[0]?.id ?? '';
  rop = await makeStaff('rop', `РОП Доска ${tag}`);
  operator = await makeStaff('operator', `Оператор Доска ${tag}`, true);
  await seedDeal(ids.backDeal, 'offer', NAME.back, operator);
  await seedDeal(ids.forwardDeal, 'booked', NAME.forward, operator);
  await seedClient(NAME.call, operator);
});

test.afterAll(async () => {
  await sql?.end();
});

const tileOf = (page: Page, name: string) => page.getByTestId('deal-tile').filter({ hasText: name });
const column = (page: Page, key: string) => page.getByTestId(`col-${key}`);

test('доска сделок: «Переместить в…» → тост с «Отменить»; отмена в окне ничего не отправляет', async ({ page }) => {
  const posts: string[] = [];
  await page.route('**/api/deals/*/stage', async (route) => {
    posts.push(route.request().postData() ?? '');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await login(page, rop);
  await page.goto('/deals');
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeVisible();
  await expect(column(page, 'offer').getByText(NAME.back)).toBeVisible();

  await tileOf(page, NAME.back).getByTestId('deal-move').click();
  const picker = page.getByTestId('move-picker');
  await expect(picker).toBeVisible();
  // «Пришёл» требует отметки явки: недоступен с причиной
  await expect(picker.getByTestId('pick-attended')).toBeDisabled();
  await expect(picker.getByTestId('pick-attended')).toContainText('Нужна отметка явки');
  await picker.getByTestId('pick-booked').click();

  // плитка переехала сразу, тост с «Отменить»
  await expect(column(page, 'booked').getByText(NAME.back)).toBeVisible();
  await expect(page.getByText('Перенесено в «Записан»')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(column(page, 'offer').getByText(NAME.back)).toBeVisible();
  await page.waitForTimeout(6000);
  expect(posts).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('перенос уходит на сервер через 5 секунд с версией сделки', async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  let sentAt = 0;
  await page.route('**/api/deals/*/stage', async (route) => {
    sentAt = Date.now();
    posts.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await login(page, rop);
  await page.goto('/deals');
  await tileOf(page, NAME.back).getByTestId('deal-move').click();
  const movedAt = Date.now();
  await page.getByTestId('pick-booked').click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  expect(sentAt - movedAt).toBeGreaterThanOrEqual(4500);
  expect(posts[0]).toMatchObject({ stageKey: 'booked', version: 0, nextStep: null });
  expect(typeof posts[0]!.opId).toBe('string');
});

test('нехватка следующего шага: панель только с недостающим, отправка сразу по «Перенести»', async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  await page.route('**/api/deals/*/stage', async (route) => {
    posts.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await login(page, rop);
  await page.goto('/deals');
  await tileOf(page, NAME.forward).getByTestId('deal-move').click();
  await page.getByTestId('pick-offer').click();
  const panel = page.getByTestId('move-panel');
  await expect(panel).toBeVisible();
  const submit = page.getByTestId('move-submit');
  await expect(submit).toBeDisabled();
  await panel.getByTestId('move-due').fill('2030-01-15T10:00');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ stageKey: 'offer', nextStep: { kind: 'call' } });
  expect(typeof (posts[0]!.nextStep as { dueAt: number }).dueAt).toBe('number');
});

test('оператору вид «Обзвон» недоступен, API отвечает 403; гостю 401', async ({ browser, request }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, operator);
  expect((await page.request.get('/api/kanban/calling')).status()).toBe(403);
  await page.context().close();
  expect((await request.get('/api/kanban/calling')).status()).toBe(401);
  expect((await request.get('/api/kanban/deals')).status()).toBe(401);
});

test('вид «Обзвон»: перенос карточки = итог «Перезвонить» с via manual_entry', async ({ page }) => {
  await login(page, rop);
  await page.goto('/deals/calling');
  await expect(page.getByRole('heading', { name: 'Обзвон', level: 1 })).toBeVisible();
  const tile = page.getByTestId('calling-tile').filter({ hasText: NAME.call });
  await expect(tile).toBeVisible();
  await tile.getByTestId('calling-move').click();
  await expect(page.getByTestId('cpick-new')).toBeDisabled();
  await page.getByTestId('cpick-callback').click();

  // шторка итога только с видами цели; единственный итог выбран сразу
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('outcome-callback')).toBeVisible();
  await expect(sheet.getByTestId('outcome-no_answer')).toHaveCount(0);
  await sheet.getByTestId('lpr-yes').click();
  await page.getByRole('button', { name: /^Через|^Завтра/ }).first().click();
  await page.getByTestId('sheet-save').click();

  await expect(page.getByText('Итог внесён вручную')).toBeVisible();
  await expect(page.getByTestId('ccol-callback').getByText(NAME.call)).toBeVisible();
  const rows = await sql<{ via: string; user_id: string }[]>`
    SELECT c.via, c.user_id FROM calls c JOIN clients cl ON cl.id = c.client_id WHERE cl.name = ${NAME.call}`;
  expect(rows.map((r) => [r.via, r.user_id])).toEqual([['manual_entry', rop.id]]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
