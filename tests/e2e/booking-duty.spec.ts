// Дежурство на групповом мероприятии (B4): РОП с телефона отмечает явку, «Остальные не пришли», исправляет одну
// отметку, вводит гостя без записи по номеру существующего клиента. Только синтетика (+7 709 …).
// БД — E2E_DATABASE_URL (та же, что у запущенного сервера).
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, prepareDb, sql } from './support/calling';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');

const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const pretty = (p: string) => `8 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}`;
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(() => prepareDb());

interface Guest {
  clientId: string;
  cardId: string;
  name: string;
  phone: string;
}

/** РОП, мероприятие сегодня (началось не меньше часа назад), 5 записанных гостей и клиент, который придёт без записи. */
async function makeWorld(): Promise<{ rop: { phone: string }; eventId: string; guests: Guest[]; walkIn: Guest }> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  if (!space) throw new Error('нет пространства sales');
  const t = Date.now();
  const ropId = randomUUID();
  const rop = { phone: `7709${digits(7)}` };
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${ropId}, ${rop.phone}, 'РОП Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${ropId}, ${space.id}, 'rop', FALSE, ${t}, ${t})`;
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${ownerId}, ${`7709${digits(7)}`}, 'Оператор Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${ownerId}, ${space.id}, 'operator', FALSE, ${t}, ${t})`;

  // Мероприятие началось час назад, но не раньше начала местных суток (Asia/Almaty, UTC+5)
  const localMidnight = Math.floor((t + 5 * 3_600_000) / 86_400_000) * 86_400_000 - 5 * 3_600_000;
  const startsAt = Math.max(t - 3_600_000, localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  const eventId = randomUUID();
  await sql`UPDATE events SET status = 'cancelled', occurrence_key = NULL, updated_at = ${t} WHERE space_id = ${space.id} AND status = 'scheduled'`;
  await sql`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, occurrence_key, touched, created_at, updated_at)
    VALUES (${eventId}, ${space.id}, NULL, 'br', ${stamp.slice(0, 10)}, ${stamp.slice(11, 16)}, ${startsAt}, 180, 'Зал 1', 'offline', 30, 'scheduled', NULL, FALSE, ${t}, ${t})`;

  const tag = digits(5);
  const make = async (i: number, booked: boolean): Promise<Guest> => {
    const g: Guest = { clientId: randomUUID(), cardId: randomUUID(), name: `ТОО Синтетика ${tag} №${i}`, phone: `7709${digits(7)}` };
    await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
              VALUES (${g.clientId}, 'company', ${g.name}, ${g.name.toLowerCase()}, ${g.name.toLowerCase()}, 'import', ${t}, ${t})`;
    await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${randomUUID()}, ${g.clientId}, ${g.phone}, 'mobile', TRUE, ${t})`;
    await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
              VALUES (${g.cardId}, ${space.id}, ${g.clientId}, ${ownerId}, 'agreed', ${t}, ${t}, ${t})`;
    if (booked) {
      await sql`
        INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, booking_date, start_time, starts_at, duration_min, status,
                              booked_by_user_id, responsible_user_id, version, created_at, updated_at)
        VALUES (${randomUUID()}, ${space.id}, 'group', 'br', ${eventId}, ${g.clientId}, ${g.cardId}, ${stamp.slice(0, 10)}, ${stamp.slice(11, 16)}, ${startsAt}, 180,
                'registered', ${ownerId}, ${ownerId}, 0, ${t}, ${t})`;
    }
    return g;
  };
  const guests: Guest[] = [];
  for (let i = 1; i <= 5; i++) guests.push(await make(i, true));
  const walkIn = await make(6, false);
  return { rop, eventId, guests, walkIn };
}

test('РОП на телефоне: явка, «Остальные не пришли», исправление, гость без записи', async ({ page }) => {
  const w = await makeWorld();
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill(pretty(w.rop.phone));
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');

  // Одно мероприятие сегодня — сразу экран дежурства
  await page.goto('/duty');
  await page.waitForURL(`**/duty/${w.eventId}`);
  await expect(page.getByTestId('guest-row')).toHaveCount(5);
  await expect(page.getByTestId('count-unmarked')).toHaveText('Не отмечено: 5');
  expect(await noHScroll(page)).toBe(true);

  // «Пришёл» у двух
  const rows = page.getByTestId('guest-row');
  for (let i = 0; i < 2; i++) await rows.nth(i).getByRole('button', { name: 'Пришёл', exact: true }).click();
  await expect(page.getByTestId('count-attended')).toHaveText('Пришли: 2');
  await expect(page.getByTestId('count-unmarked')).toHaveText('Не отмечено: 3');

  // «Остальные не пришли» с подтверждением
  await page.getByRole('button', { name: 'Остальные не пришли' }).click();
  await expect(page.getByText('Отметить «Не пришёл» у 3 гостей?')).toBeVisible();
  await page.getByRole('button', { name: 'Отметить', exact: true }).click();
  await expect(page.getByText('Отмечено: 3')).toBeVisible();
  await expect(page.locator('[data-testid="guest-row"][data-status="no_show"]')).toHaveCount(3);
  await expect(page.getByTestId('count-unmarked')).toHaveText('Не отмечено: 0');

  // Исправление одной отметки
  await page.locator('[data-testid="guest-row"][data-status="no_show"]').first().getByRole('button', { name: 'Отметить «Пришёл»' }).click();
  await expect(page.getByTestId('count-attended')).toHaveText('Пришли: 3');
  await expect(page.locator('[data-testid="guest-row"][data-status="no_show"]')).toHaveCount(2);

  // Гость без записи по номеру существующего клиента
  await page.getByRole('button', { name: 'Гость без записи' }).click();
  await page.getByLabel('Номер телефона').fill(pretty(w.walkIn.phone));
  await page.getByLabel('Имя').fill('Гость Синтетик');
  await page.getByRole('button', { name: 'Отметить гостя' }).click();
  await expect(page.getByText('Номер найден, гость отмечен')).toBeVisible();
  await expect(page.getByTestId('guest-row')).toHaveCount(6);
  await expect(page.getByTestId('count-attended')).toHaveText('Пришли: 4');
  // Строка гостя без записи — без названия клиента
  await expect(page.getByText('Гость без записи', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(w.walkIn.name)).toHaveCount(0);

  const [b] = await sql<{ status: string; via: string; clientId: string }[]>`SELECT status, via, client_id AS "clientId" FROM bookings WHERE event_id = ${w.eventId} AND via = 'walk_in'`;
  expect([b?.status, b?.via, b?.clientId]).toEqual(['attended', 'walk_in', w.walkIn.clientId]);
  expect(await noHScroll(page)).toBe(true);
});
