// Мастер записи (B3a): итог «Договорились» → мастер → запись; перенос; гонка за последнее место; заявка на
// консультацию; карточка без итога. Только синтетика (+7 709 …). БД — E2E_DATABASE_URL (та же, что у сервера).
// Запуск: next start в production требует синтетический CRM_PHONE_HMAC_KEY (итог пишет хэш номера).
// Итог ставится через API (шторки итога ещё нет, C7a): сквозной путь через шторку — у tester после C7a.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';

const DB_URL = process.env.E2E_DATABASE_URL;
test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const PASSWORD = 'Надёжный-пароль-77';
const ORIGIN = `http://localhost:${Number(process.env.E2E_PORT) || 3100}`;
const sql = DB_URL ? postgres(DB_URL, { max: 3 }) : (null as never);
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const DAY = 86_400_000;

interface World {
  userId: string;
  phone: string;
  clientId: string;
  cardId: string;
  contactId: string;
  name: string;
}

test.beforeAll(() => {
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/support/prepare-db.ts'], { stdio: 'inherit', env: { ...process.env } });
});
test.afterAll(async () => {
  await sql?.end();
});

/** Местная дата Asia/Almaty (UTC+5) через N суток от сейчас. */
const localDate = (plusDays: number) => new Date(Date.now() + plusDays * DAY + 5 * 3_600_000).toISOString().slice(0, 10);

/** Оператор, клиент «ТОО Тест Альфа», контакт и карточка (новая) в его очереди. */
async function makeWorld(state = 'new'): Promise<World> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales');
  const t = Date.now();
  const w: World = { userId: randomUUID(), phone: `7709${digits(7)}`, clientId: randomUUID(), cardId: randomUUID(), contactId: randomUUID(), name: `ТОО Тест Альфа ${digits(4)}` };
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${w.userId}, ${w.phone}, 'Оператор Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${w.userId}, ${space.id}, 'operator', FALSE, ${t}, ${t})`;
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            VALUES (${w.clientId}, 'company', ${w.name}, ${w.name.toLowerCase()}, ${w.name.toLowerCase()}, 'import', ${t}, ${t})`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${randomUUID()}, ${w.clientId}, ${`7709${digits(7)}`}, 'mobile', TRUE, ${t})`;
  await sql`INSERT INTO contacts (id, client_id, name, is_decision_maker, created_at) VALUES (${w.contactId}, ${w.clientId}, 'Контакт Синтетик', TRUE, ${t})`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
            VALUES (${w.cardId}, ${space.id}, ${w.clientId}, ${w.userId}, ${state}, ${t}, ${t}, ${t})`;
  return w;
}

/** Мероприятия вида «групповой» в пространстве: прежние снимаем, чтобы предложение было предсказуемым. */
async function seedEvents(specs: Array<{ id: string; plusDays: number; capacity?: number }>): Promise<void> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  await sql`UPDATE events SET status = 'cancelled', occurrence_key = NULL, updated_at = ${Date.now()} WHERE space_id = ${space!.id} AND status = 'scheduled'`;
  for (const e of specs) {
    const date = localDate(e.plusDays);
    const startsAt = Date.parse(`${date}T15:00:00+05:00`);
    await sql`
      INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, occurrence_key, touched, created_at, updated_at)
      VALUES (${e.id}, ${space!.id}, NULL, 'br', ${date}, '15:00', ${startsAt}, 180, 'Зал 1', 'offline', ${e.capacity ?? 30}, 'scheduled', NULL, FALSE, ${Date.now()}, ${Date.now()})`;
  }
}

async function login(page: Page, w: World): Promise<void> {
  await page.goto('/login');
  const p = w.phone;
  await page.getByLabel('Номер телефона').fill(`8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
}

/** Итог «Договорились» через API: ЛПР, контакт, дата договорённости (запись — позже, мастером). */
async function agree(page: Page, w: World): Promise<string> {
  const opId = randomUUID();
  const res = await page.request.post('/api/calls/outcomes', {
    headers: { Origin: ORIGIN },
    data: {
      opId, cardId: w.cardId, outcomeKey: 'agreed', via: 'ui', occurredAt: Date.now(), tappedAt: null, phoneId: null, reasonCode: '', note: '', lpr: 'yes',
      lprInfo: null, callbackAt: null, markTarget: false, alsoDncPhoneIds: [], fields: { niche: 'services' }, durationSec: null,
      agreement: { contactId: w.contactId, agreedDueAt: Date.now() + DAY, booking: null },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return opId;
}

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function expectTap44(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  void page;
}

test('итог «Договорились» → мастер → запись → тост «Отменить», карточка и «Записи»', async ({ page }) => {
  const w = await makeWorld();
  await seedEvents([{ id: randomUUID(), plusDays: 3 }, { id: randomUUID(), plusDays: 10 }]);
  await login(page, w);
  const opId = await agree(page, w);
  await page.goto(`/bookings/new/${w.cardId}`);

  await page.getByRole('tab', { name: 'БР' }).click();
  await expect(page.getByText('Осталось 30 мест из 30').first()).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
  const book = page.getByRole('button', { name: /^Записать на / });
  await expectTap44(page, book);
  await book.click();
  await expect(page.getByText(new RegExp(`^Записать ${w.name} на БР `))).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.getByText(/^Записан: БР, /).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отменить' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'К карточке клиента' })).toBeVisible();

  const [row] = await sql<{ status: string; kind: string }[]>`SELECT status, kind FROM bookings WHERE client_id = ${w.clientId}`;
  expect([row?.status, row?.kind]).toEqual(['registered', 'group']);
  const [task] = await sql<{ status: string }[]>`SELECT status FROM tasks WHERE source_key = ${`agreement:${opId}`}`;
  expect(task?.status).toBe('done');

  await page.getByRole('link', { name: 'К карточке клиента' }).click();
  await expect(page.getByText('Запись на мероприятие').first()).toBeVisible();
  await page.goto('/bookings');
  await expect(page.getByText(w.name)).toBeVisible();
  await expect(page.getByText('Записан', { exact: true }).first()).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});

test('повтор = перенос: «Сейчас: …» → «Перенести на …» → «Перенесено»', async ({ page }) => {
  const w = await makeWorld('agreed');
  await seedEvents([{ id: randomUUID(), plusDays: 3 }, { id: randomUUID(), plusDays: 10 }]);
  await login(page, w);
  await page.goto(`/bookings/new/${w.cardId}`);
  await page.getByRole('tab', { name: 'БР' }).click();
  await page.getByRole('button', { name: /^Записать на / }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Записан: БР/).first()).toBeVisible();

  await page.goto(`/bookings/new/${w.cardId}`);
  await page.getByRole('tab', { name: 'БР' }).click();
  await expect(page.getByText(/^Сейчас: /)).toBeVisible();
  await page.getByRole('button', { name: /^Перенести на / }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Перенесено: БР/).first()).toBeVisible();
  const rows = await sql<{ status: string }[]>`SELECT status FROM bookings WHERE client_id = ${w.clientId} ORDER BY created_at`;
  expect(rows.map((r) => r.status)).toEqual(['moved', 'registered']);
});

test('гонка за последнее место: «Мест … не осталось», даты из ответа, выбор → успех тем же ключом', async ({ page }) => {
  const w = await makeWorld('agreed');
  const full = randomUUID();
  await seedEvents([{ id: full, plusDays: 3, capacity: 1 }, { id: randomUUID(), plusDays: 10 }]);
  await login(page, w);
  await page.goto(`/bookings/new/${w.cardId}`);
  await page.getByRole('tab', { name: 'БР' }).click();
  await page.getByRole('button', { name: /^Записать на / }).click();
  // последнее место занял другой клиент, пока мастер был открыт
  const other = await makeWorld('agreed');
  const [ev] = await sql<{ spaceId: string; eventDate: string; startsAt: number }[]>`SELECT space_id AS "spaceId", event_date AS "eventDate", starts_at AS "startsAt" FROM events WHERE id = ${full}`;
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, booking_date, start_time, starts_at, duration_min, status, version, created_at, updated_at)
            VALUES (${randomUUID()}, ${ev!.spaceId}, 'group', 'br', ${full}, ${other.clientId}, ${other.cardId}, ${ev!.eventDate}, '15:00', ${ev!.startsAt}, 180, 'registered', 0, ${Date.now()}, ${Date.now()})`;
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Мест на .* не осталось\. Выберите другую дату\.$/)).toBeVisible();
  await page.getByRole('button', { name: /^Записать на / }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Записан: БР/).first()).toBeVisible();
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE client_id = ${w.clientId}`;
  expect(rows[0]?.n).toBe(1);
});

test('заявка на консультацию: направление → день → время → «Оставить заявку…» → в «Записях» «Без консультанта»', async ({ page }) => {
  const w = await makeWorld('agreed');
  await login(page, w);
  await page.goto(`/bookings/new/${w.cardId}`);
  await page.getByRole('tab', { name: 'БК' }).click();
  await page.getByRole('button', { name: 'Маркетинг' }).click();
  const firstDay = page.getByRole('group', { name: 'День' }).getByRole('button').first();
  await expectTap44(page, firstDay);
  await firstDay.click();
  await page.getByRole('group', { name: 'Время' }).getByRole('button').first().click();
  expect(await noHScroll(page)).toBe(true);
  await expect(page.getByText('Без консультанта — назначит руководитель')).toBeVisible();
  await page.getByRole('button', { name: /^Оставить заявку на / }).click();
  await expect(page.getByText(/направление «Маркетинг»\? Консультанта назначит руководитель\.$/)).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText(/^Заявка: БК, /).first()).toBeVisible();

  const [row] = await sql<{ kind: string; resourceId: string | null; directionKey: string }[]>`SELECT kind, resource_id AS "resourceId", direction_key AS "directionKey" FROM bookings WHERE client_id = ${w.clientId}`;
  expect([row?.kind, row?.resourceId, row?.directionKey]).toEqual(['individual', null, 'marketing']);
  await page.goto('/bookings');
  await expect(page.getByText(w.name)).toBeVisible();
  await expect(page.getByText('Без консультанта')).toBeVisible();
});

test('карточка в «Перезвонить»: «Сначала итог «Договорились»», кнопки «Подтвердить» нет', async ({ page }) => {
  const w = await makeWorld('callback');
  await login(page, w);
  await page.goto(`/bookings/new/${w.cardId}`);
  await expect(page.getByText('Сначала итог «Договорились»')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подтвердить' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'К карточке клиента' })).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});
