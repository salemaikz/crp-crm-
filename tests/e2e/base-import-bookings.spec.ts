// Импорт «Записи» (C4b, D-324): РОП загружает CSV записей, подтверждает автора, смотрит предпросмотр и применяет;
// гость виден в списке дежурного на мероприятии, карточка у оператора — «Договорились», задача «Уточнить
// договорённость» закрыта. Экран РОП — размер ноутбука, дежурный список — телефон (pixel-7).
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у запущенного сервера).
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, prepareDb, sql } from './support/calling';
import { uniquePhone } from './support/phones';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const LAPTOP = { width: 1280, height: 800 };

test.beforeAll(() => prepareDb());

async function makeStaff(spaceId: string, role: string, name: string): Promise<{ id: string; phone: string }> {
  const id = randomUUID();
  const phone = await uniquePhone(sql);
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${spaceId}, ${role}, FALSE, ${t}, ${t})`;
  return { id, phone };
}

async function loginAs(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

test('РОП загружает записи: автор, предпросмотр, применение; гость в списке дежурного, карточка — «Договорились»', async ({ page }) => {
  const tag = digits(5);
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales');
  const t = Date.now();
  const rop = await makeStaff(space.id, 'rop', `РОП Синтетик ${tag}`);
  const operatorName = `Оператор Синтетик ${tag}`;
  const operator = await makeStaff(space.id, 'operator', operatorName);

  // Мероприятие сегодня (началось не меньше часа назад, но не раньше начала местных суток Asia/Almaty, UTC+5)
  const localMidnight = Math.floor((t + 5 * 3_600_000) / 86_400_000) * 86_400_000 - 5 * 3_600_000;
  const startsAt = Math.max(t - 3_600_000, localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  const date = stamp.slice(0, 10);
  const eventId = randomUUID();
  await sql`UPDATE events SET status = 'cancelled', occurrence_key = NULL, updated_at = ${t} WHERE space_id = ${space.id} AND status = 'scheduled'`;
  await sql`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, occurrence_key, touched, created_at, updated_at)
    VALUES (${eventId}, ${space.id}, NULL, 'br', ${date}, ${stamp.slice(11, 16)}, ${startsAt}, 180, 'Зал 1', 'offline', 30, 'scheduled', NULL, FALSE, ${t}, ${t})`;

  // Клиент после таблицы операторов: «Перезвон: сейчас» и задача «Уточнить договорённость»
  const name = `ТОО Синтетика ${tag}`;
  const phone = await uniquePhone(sql);
  const clientId = randomUUID();
  const cardId = randomUUID();
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${clientId}, 'company', ${name}, ${`синтетика ${tag}`}, ${name.toLowerCase()}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${randomUUID()}, ${clientId}, ${phone}, 'mobile', TRUE, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, next_call_at, assigned_at, created_at, updated_at)
            VALUES (${cardId}, ${space.id}, ${clientId}, ${operator.id}, 'callback', ${t}, ${t}, ${t}, ${t})`;
  await sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, status, assignee_user_id, source_key, created_at)
            VALUES (${randomUUID()}, ${space.id}, ${clientId}, 'call', 'clarify_import', '', 'open', ${operator.id}, ${`clarify_import:e2e:${clientId}`}, ${t})`;

  // Таблица записей: заголовки профиля, дата в формате ДД.ММ.ГГГГ, оператор по ярлыку
  const [y, m, d] = date.split('-');
  const csv = ['Наименование;Телефон;БИН;Дата;Время;Оператор;Мероприятие', `${name};+${phone.slice(0, 1)} ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7, 9)} ${phone.slice(9)};;${d}.${m}.${y};;Оператор-01;БР`].join('\n');

  await page.setViewportSize(LAPTOP);
  await loginAs(page, rop.phone);
  await page.goto('/import');
  await page.getByLabel('Профиль').selectOption('bookings_table');
  await page.locator('input[type=file]').setInputFiles({ name: 'записи.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/\/import\/[0-9a-f-]{36}/);

  // Карта авторов: подсказки нет (ярлык не ФИО и не номер) — РОП выбирает сотрудника
  await expect(page.getByRole('heading', { name: 'Кто записал гостя' })).toBeVisible();
  await page.getByLabel('Оператор-01', { exact: true }).selectOption({ label: operatorName });
  await page.getByRole('button', { name: 'Показать предпросмотр' }).click();
  await expect(page.getByRole('heading', { name: 'Что произойдёт' })).toBeVisible();
  await expect(page.getByText('Будет записано', { exact: true })).toBeVisible();
  await expect(page.getByText('Перейдут в «Договорились»')).toBeVisible();
  const apply = page.getByRole('button', { name: 'Применить', exact: true });
  await expect(apply).toBeEnabled();
  expect(await noHScroll(page)).toBe(true);
  // Плитки предпросмотра (D-331): каждая сетка — одним рядом или ровными рядами, без одной плитки в последнем ряду
  const tileRows = await page.locator('.k-statgrid').evaluateAll((grids) =>
    grids.map((g) => {
      const tops = [...g.children].map((c) => Math.round(c.getBoundingClientRect().top));
      const rows = [...new Set(tops)];
      return { n: tops.length, first: tops.filter((x) => x === rows[0]).length, last: tops.filter((x) => x === rows[rows.length - 1]).length };
    }),
  );
  expect(tileRows.length).toBeGreaterThan(0);
  for (const g of tileRows) expect(g.n === g.first || g.last * 2 >= g.first, `плиток ${g.n}: ряд ${g.first}, последний ${g.last}`).toBe(true);

  await apply.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Что записано' })).toBeVisible();

  // В БД: запись из импорта с автором, карточка «Договорились», задача закрыта, сделка, импортный звонок без сотрудника
  const [b] = await sql<{ via: string; status: string; booker: string; eventId: string; key: string }[]>`
    SELECT via, status, booked_by_user_id AS booker, event_id AS "eventId", import_key AS key FROM bookings WHERE client_id = ${clientId}`;
  expect(b).toMatchObject({ via: 'import', status: 'registered', booker: operator.id, eventId });
  expect(b?.key).toMatch(/^bk:[0-9a-f]{64}$/);
  const [card] = await sql<{ state: string }[]>`SELECT state FROM cards WHERE id = ${cardId}`;
  expect(card?.state).toBe('agreed');
  const [task] = await sql<{ status: string }[]>`SELECT status FROM tasks WHERE client_id = ${clientId} AND source = 'clarify_import'`;
  expect(task?.status).not.toBe('open');
  const [call] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calls WHERE card_id = ${cardId} AND via = 'import' AND user_id IS NULL AND outcome_kind = 'agreed'`;
  expect(call?.n).toBe(1);

  // История записи: действие import от РОП, автор записи (booked_by) — оператор из карты авторов
  const hist = await sql<{ actor: string | null; action: string }[]>`
    SELECT h.actor_id AS actor, h.action FROM booking_history h JOIN bookings bk ON bk.id = h.booking_id WHERE bk.client_id = ${clientId}`;
  expect(hist.find((h) => h.action === 'import')?.actor).toBe(rop.id);

  // Оператор-автор открывает свою карточку: имя клиента и состояние «Договорились»
  const opPage = await page.context().browser()!.newContext({ ...test.info().project.use });
  const op = await opPage.newPage();
  await loginAs(op, operator.phone);
  await op.goto(`/clients/${clientId}`);
  await expect(op.getByText(name).first()).toBeVisible();
  await expect(op.getByText('Договорились').first()).toBeVisible();
  await opPage.close();

  // Повтор того же файла: новых записей, карточек и звонков нет, применять нечего
  const total = async () => (await sql<{ n: number }[]>`SELECT (SELECT count(*) FROM bookings)::int + (SELECT count(*) FROM calls)::int AS n`)[0]?.n;
  const before = await total();
  await page.goto('/import');
  await page.getByLabel('Профиль').selectOption('bookings_table');
  await page.locator('input[type=file]').setInputFiles({ name: 'записи.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });
  await page.getByRole('button', { name: 'Загрузить и проверить' }).click();
  await page.waitForURL(/\/import\/[0-9a-f-]{36}/);
  const sel = page.getByLabel('Оператор-01', { exact: true });
  if (await sel.count()) {
    await sel.selectOption({ label: operatorName });
    await page.getByRole('button', { name: 'Показать предпросмотр' }).click();
  }
  await expect(page.getByText('Этот файл уже применён')).toBeVisible();
  await expect(page.getByText('Новых записей нет')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Применить', exact: true })).toBeDisabled();
  expect(await total()).toBe(before);
  expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE client_id = ${clientId}`)[0]?.n).toBe(1);

  // Дежурный список на телефоне: гость из импорта на мероприятии
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/duty');
  await page.waitForURL(`**/duty/${eventId}`);
  await expect(page.getByTestId('guest-row')).toHaveCount(1);
  await expect(page.getByTestId('guest-row')).toContainText(name);
  expect(await noHScroll(page)).toBe(true);
});

test('директор: загрузка записей — 423, оператор — 403; данные не меняются', async ({ page }) => {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales');
  const tag = digits(5);
  const director = await makeStaff(space.id, 'director', `Директор Синтетик ${tag}`);
  const operator = await makeStaff(space.id, 'operator', `Оператор Синтетик ${tag}`);
  const post = () =>
    page.evaluate(async () => {
      const res = await fetch('/api/import/uploads?profile=bookings_table', {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-file-name': encodeURIComponent('записи.csv') },
        body: 'Наименование;Телефон;Дата\nТОО Х;+7 709 000 00 00;01.01.2030',
      });
      return res.status;
    });
  const count = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM imports`)[0]?.n;
  const before = await count();
  await loginAs(page, director.phone);
  expect(await post()).toBe(423);
  await page.context().clearCookies();
  await loginAs(page, operator.phone);
  expect(await post()).toBe(403);
  expect(await count()).toBe(before);
});
