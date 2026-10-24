// Отчёты за период на телефоне: РОП открывает таблицу операторов, переключает вкладки и период, неверный период в адресе
// даёт сообщение, оператору экрана нет. Сотрудники и звонки создаются прямо в БД приложения (E2E_DATABASE_URL, настройки
// пресета уже применены); без неё — пропуск. Синтетика: номера +7 709 ….
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
let tag = 0;
let bookingClient = '';
let bookingDay = '';

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

test.beforeAll(async () => {
  const space = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE is_default LIMIT 1`;
  spaceId = space[0]?.id ?? '';
  tag = Math.floor(Math.random() * 90000) + 10000;
  rop = await makeStaff('rop', `РОП Отчёты ${tag}`);
  operator = await makeStaff('operator', `Оператор Отчёты ${tag}`, true);
  // два итога оператора за последние минуты: в одном местном часе, если не на границе часа
  const now = Date.now();
  const clientId = randomUUID();
  const cardId = randomUUID();
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', 'ТОО Синтетика Отчёты', 'синтетика отчёты', 'синтетика отчёты', 'import', ${now}, ${now})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, created_at, updated_at)
            VALUES (${cardId}, ${spaceId}, ${clientId}, ${operator.id}, 'retry', ${now}, ${now})`;
  // две прошедшие записи этого клиента (пришёл, не отмечено) — для списка явки
  bookingClient = clientId;
  const startsAt = now - 2 * 3_600_000;
  bookingDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt));
  for (const [i, status] of (['attended', 'registered'] as const).entries()) {
    await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, booking_date, start_time, starts_at, duration_min, status, via,
                                    booked_by_user_id, responsible_user_id, created_at, updated_at)
              VALUES (${randomUUID()}, ${spaceId}, 'individual', 'bk', ${clientId}, ${cardId}, ${bookingDay}, '11:00', ${startsAt - i * 60_000}, 60, ${status}, 'ui',
                      ${operator.id}, ${operator.id}, ${now}, ${now})`;
  }
  for (const [i, kind] of (['no_answer', 'callback'] as const).entries()) {
    await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, lpr, applied, occurred_at, received_at, config_rev)
              VALUES (${randomUUID()}, ${spaceId}, ${cardId}, ${clientId}, ${operator.id}, 'ui', '', ${kind}, ${kind}, '', 'applied', ${now - (i + 1) * 1000}, ${now}, 1)`;
  }
});

test.afterAll(async () => {
  await sql?.end();
});

test('РОП открывает отчёт «Операторы»: период, таблица, строка оператора, страница без горизонтальной прокрутки', async ({ page }) => {
  await login(page, rop);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Быстрый выбор' }).getByRole('button', { name: 'Эта неделя' })).toHaveAttribute('aria-pressed', 'true');
  const row = page.getByRole('row', { name: new RegExp(`Оператор Отчёты ${tag}`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2'); // итогов
  await expect(page.getByRole('row', { name: /^Итого / })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('вкладки и период: воронка, выручка, «Вчера» перечитывает данные, адрес повторяет выбор', async ({ page }) => {
  await login(page, rop);
  await page.goto('/reports');
  await page.getByRole('button', { name: 'Воронка' }).click();
  await expect(page.getByText('Воронка периода:')).toBeVisible();
  await expect(page).toHaveURL(/r=funnel/);
  const reply = page.waitForResponse((r) => r.url().includes('/api/reports/revenue') && r.status() === 200);
  await page.getByRole('button', { name: 'Выручка' }).click();
  await reply;
  await expect(page.getByRole('button', { name: 'Выручка' })).toHaveAttribute('aria-pressed', 'true');
  // выигранных сделок за неделю может не быть: тогда вместо таблицы подсказка
  await expect(page.getByRole('columnheader', { name: 'Тип услуги' }).or(page.getByText('За период данных нет'))).toBeVisible();
  // «Вчера»: итогов оператора вчера нет — оператор в таблице операторов без чисел
  await page.getByRole('button', { name: 'Операторы' }).click();
  const yesterday = page.waitForResponse((r) => r.url().includes('/api/reports/operators') && r.url().includes('from=') && r.status() === 200);
  await page.getByRole('button', { name: 'Вчера' }).click();
  await yesterday;
  await expect(page.getByRole('group', { name: 'Быстрый выбор' }).getByRole('button', { name: 'Вчера' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/r=operators/);
});

test('неверный период в адресе — сообщение на экране, а не ошибка страницы; ссылка с выбором открывается', async ({ page }) => {
  await login(page, rop);
  await page.goto('/reports?r=operators&from=2020-01-01&to=2026-10-01');
  await expect(page.getByText(/Период указан неверно/).first()).toBeVisible();
  await page.goto('/reports?r=attendance&by=consultant');
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Явка' })).toHaveAttribute('aria-pressed', 'true');
});

test('оператор отчёты не открывает, API отвечает 403; гость — 401', async ({ browser, request }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, operator);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 1 })).toHaveCount(0);
  expect((await page.request.get('/api/reports/operators')).status()).toBe(403);
  await page.context().close();
  expect((await request.get('/api/reports/operators')).status()).toBe(401);
});

test('«Явка — список»: клиент — ссылка, чипы-счётчики ставят фильтр статуса (A5)', async ({ page }) => {
  await login(page, rop);
  await page.goto(`/reports?r=attendance&view=list&from=${bookingDay}&to=${bookingDay}`);
  await expect(page.getByRole('group', { name: 'Показать' }).or(page.getByLabel('Показать')).first()).toBeVisible();
  const chips = page.getByTestId('attendance-chips');
  await expect(chips).toBeVisible();
  await expect(chips.getByRole('button', { name: /^Пришли/ })).toContainText('1');
  await expect(chips.getByRole('button', { name: /^Не отмечено/ })).toContainText('1');
  const link = page.getByTestId('attendance-client-link').first();
  await expect(link).toHaveAttribute('href', `/clients/${bookingClient}`);
  await chips.getByRole('button', { name: /^Не отмечено/ }).click();
  await expect(page.getByTestId('attendance-chip-unmarked')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/status=unmarked/);
  await expect(page.getByRole('columnheader', { name: 'Мероприятие' })).toBeVisible();
});
