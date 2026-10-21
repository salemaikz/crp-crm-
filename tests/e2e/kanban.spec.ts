// Доски РОП на телефоне (B8, D-266): «Переместить в…», отложенная отправка 5 с с «Отменить», панель недостающего,
// вид «Обзвон» (перенос = итог с via manual_entry). Данные создаются прямо в БД приложения (E2E_DATABASE_URL);
// без неё тесты пропускаются. Перенос идёт в настоящий маршрут сделок B6 (`POST /api/deals/[id]/stage`): ничего не
// подменяется, результат проверяется по БД.
// Синтетика: номера 709 xxx xx xx (код не выдан ни одному оператору), компании выдуманные.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';
import { uniquePhone } from './support/phones';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : (null as never);
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const phone = () => uniquePhone(sql);

type Staff = { id: string; phone: string; name: string };
let spaceId = '';
let rop: Staff;
let operator: Staff;
const tag = Math.floor(Math.random() * 90000) + 10000;
const ids = { backDeal: randomUUID(), forwardDeal: randomUUID(), staleStepDeal: randomUUID(), wonDeal: randomUUID(), lostDeal: randomUUID() };
const cards: Record<string, string> = {};
const NAME = {
  back: `ТОО Синтетика Доска ${tag} Назад`,
  forward: `ТОО Синтетика Доска ${tag} Вперёд`,
  call: `ТОО Синтетика Доска ${tag} Обзвон`,
  stale: `ТОО Синтетика Доска ${tag} Устарела`,
  staleStep: `ТОО Синтетика Доска ${tag} Шаг пропал`,
  won: `ТОО Синтетика Доска ${tag} Покупка`,
  lost: `ТОО Синтетика Доска ${tag} Проигрыш`,
};

async function makeStaff(role: string, name: string, inDistribution = false): Promise<Staff> {
  const s = { id: randomUUID(), phone: await phone(), name };
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
            VALUES (${phoneId}, ${clientId}, ${await phone()}, 'mobile', TRUE, ${now})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, attempts, assigned_at, created_at, updated_at)
            VALUES (${cardId}, ${spaceId}, ${clientId}, ${owner.id}, 'retry', 1, ${now}, ${now}, ${now})`;
  return { clientId, cardId, phoneId };
}

async function seedDeal(id: string, stageKey: string, name: string, owner: Staff): Promise<void> {
  const { clientId, cardId } = await seedClient(name, owner);
  cards[id] = cardId;
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
  await seedDeal(ids.staleStepDeal, 'booked', NAME.staleStep, operator);
  await seedDeal(ids.wonDeal, 'booked', NAME.won, operator);
  await seedDeal(ids.lostDeal, 'booked', NAME.lost, operator);
  // у «Шаг пропал» есть задача со сроком: доска считает, что шага хватает
  const t0 = Date.now();
  await sql`INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
            SELECT ${randomUUID()}, ${spaceId}, d.client_id, d.id, 'call', 'manual', '', ${t0 + 86_400_000}, ${operator.id}, 'open', NULL, ${operator.id}, ${t0}
              FROM deals d WHERE d.id = ${ids.staleStepDeal}`;
  await seedClient(NAME.call, operator);
  await seedClient(NAME.stale, operator);
});

test.afterAll(async () => {
  await sql?.end();
});

const tileOf = (page: Page, name: string) => page.getByTestId('deal-tile').filter({ hasText: name });
const column = (page: Page, key: string) => page.getByTestId(`col-${key}`);

const stageOf = async (dealId: string) => (await sql<{ stage_key: string; version: number }[]>`SELECT stage_key, version FROM deals WHERE id = ${dealId}`)[0]!;

test('доска сделок: «Переместить в…» → тост с «Отменить»; отмена в окне ничего не отправляет', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/stage')) posts.push(r.url());
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
  expect(await stageOf(ids.backDeal)).toMatchObject({ stage_key: 'offer', version: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('перенос уходит в настоящий маршрут B6 через 5 секунд с версией сделки и меняет этап в БД', async ({ page }) => {
  const posts: Array<Record<string, unknown>> = [];
  let sentAt = 0;
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes(`/api/deals/${ids.backDeal}/stage`)) return;
    sentAt = Date.now();
    posts.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
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
  await expect.poll(async () => (await stageOf(ids.backDeal)).stage_key).toBe('booked');
  expect((await stageOf(ids.backDeal)).version).toBe(1);
  // доска перечитана: плитка остаётся в новой колонке
  await expect(column(page, 'booked').getByText(NAME.back)).toBeVisible();
});

test('перенос → требование шага → шаг → перенос прошёл (настоящий маршрут B6)', async ({ page }) => {
  await login(page, rop);
  await page.goto('/deals');
  await tileOf(page, NAME.forward).getByTestId('deal-move').click();
  await page.getByTestId('pick-offer').click();
  const panel = page.getByTestId('move-panel');
  await expect(panel).toBeVisible();
  const submit = page.getByTestId('move-submit');
  await expect(submit).toBeDisabled();
  // пока шага нет, сделка стоит на месте
  expect((await stageOf(ids.forwardDeal)).stage_key).toBe('booked');
  await panel.getByTestId('move-due').fill('2030-01-15T10:00');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await stageOf(ids.forwardDeal)).stage_key).toBe('offer');
  const tasks = await sql<{ kind: string; due_at: string }[]>`SELECT kind, due_at FROM tasks WHERE deal_id = ${ids.forwardDeal} AND status = 'open'`;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.kind).toBe('call');
  await expect(column(page, 'offer').getByText(NAME.forward)).toBeVisible();
});

test('сервер отказал 409 next_step_required (шаг пропал после загрузки): плитка назад, панель шага, затем перенос прошёл', async ({ page }) => {
  await login(page, rop);
  await page.goto('/deals');
  await expect(column(page, 'booked').getByText(NAME.staleStep)).toBeVisible();
  // доска видит задачу и считает, что шага хватает; задачу закрывают, пока страница открыта
  await sql`UPDATE tasks SET status = 'done' WHERE deal_id = ${ids.staleStepDeal}`;
  await tileOf(page, NAME.staleStep).getByTestId('deal-move').click();
  await page.getByTestId('pick-offer').click();
  await expect(column(page, 'offer').getByText(NAME.staleStep)).toBeVisible();

  // через 5 с настоящий маршрут отвечает 409: плитка возвращается, открывается панель шага
  const panel = page.getByTestId('move-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(column(page, 'booked').getByText(NAME.staleStep)).toBeVisible();
  expect((await stageOf(ids.staleStepDeal)).stage_key).toBe('booked');
  await panel.getByTestId('move-due').fill('2030-01-15T10:00');
  await page.getByTestId('move-submit').click();
  await expect.poll(async () => (await stageOf(ids.staleStepDeal)).stage_key).toBe('offer');
});

test('«Выиграна» ведёт на форму покупки по карточке сделки, а не на 404', async ({ page }) => {
  await login(page, rop);
  await page.goto('/deals');
  await tileOf(page, NAME.won).getByTestId('deal-move').click();
  await page.getByTestId('pick-paid').click();
  await page.waitForURL(`**/deals/purchase/${cards[ids.wonDeal]}`);
  await expect(page.getByRole('heading', { name: 'Покупка' })).toBeVisible();
  expect((await stageOf(ids.wonDeal)).stage_key).toBe('booked');
});

test('«Проиграна» ведёт на страницу сделки с действием «Проигран», а не на 404', async ({ page }) => {
  await login(page, rop);
  await page.goto('/deals');
  await tileOf(page, NAME.lost).getByTestId('deal-move').click();
  await page.getByTestId('pick-lost').click();
  await page.waitForURL(`**/deals/${ids.lostDeal}`);
  await expect(page.getByTestId('deal-summary')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проигран' })).toBeVisible();
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

test('вид «Обзвон»: карточку изменили после загрузки доски — 409, плитка на месте, тост, итог не записан', async ({ page }) => {
  await login(page, rop);
  await page.goto('/deals/calling');
  const tile = page.getByTestId('calling-tile').filter({ hasText: NAME.stale });
  await expect(tile).toBeVisible();
  await tile.getByTestId('calling-move').click();
  await page.getByTestId('cpick-callback').click();
  const sheet = page.getByTestId('outcome-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('lpr-yes').click();
  await page.getByRole('button', { name: /^Через|^Завтра/ }).first().click();

  // Пока РОП заполнял шторку, карточку изменили (оператор перевёл её в другое состояние)
  await sql`UPDATE cards SET version = version + 1 WHERE client_id IN (SELECT id FROM clients WHERE name = ${NAME.stale})`;
  await page.getByTestId('sheet-save').click();

  await expect(page.getByText('Сделку изменили, доска обновлена.')).toBeVisible();
  await expect(page.getByTestId('outcome-sheet')).toHaveCount(0);
  await expect(page.getByTestId('ccol-retry').getByText(NAME.stale)).toBeVisible();
  await expect(page.getByTestId('ccol-callback').getByText(NAME.stale)).toHaveCount(0);
  const rows = await sql`SELECT 1 FROM calls c JOIN clients cl ON cl.id = c.client_id WHERE cl.name = ${NAME.stale}`;
  expect(rows).toHaveLength(0);
});
