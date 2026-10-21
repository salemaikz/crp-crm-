// Обход меню по ролям (D-313): каждый пункт нижней панели, «Ещё» и боковой колонки открывается без 404.
// Оператор и консультант — телефон, РОП — ноутбук. Только синтетика (+7 709 …). БД — E2E_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql } from './support/calling';
import { makeConsultant } from './support/consult';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.beforeAll(() => prepareDb());

/** Адреса пунктов меню: на телефоне — панель и лист «Ещё», на ноутбуке — боковая колонка. */
async function menuHrefs(page: Page, mobile: boolean): Promise<string[]> {
  if (mobile) await page.getByRole('button', { name: 'Ещё' }).click();
  const scope = mobile ? page.locator('nav[aria-label="Разделы"], [role="dialog"]') : page.locator('nav[aria-label="Разделы"]');
  const all = await scope.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''));
  return [...new Set(all)].filter((h) => h !== '/account');
}

async function walk(page: Page, mobile: boolean, expected: string[]): Promise<void> {
  const hrefs = await menuHrefs(page, mobile);
  for (const h of expected) expect(hrefs, `пункт ${h} в меню`).toContain(h);
  for (const href of hrefs) {
    const res = await page.goto(href);
    expect(res?.status() ?? 0, `${href}: статус`).toBeLessThan(400);
    await expect(page.getByText('This page could not be found'), `${href}: не 404`).toHaveCount(0);
    await expect(page.locator('h1, h2, [role="heading"]').first(), `${href}: есть заголовок`).toBeVisible();
  }
}

test('оператор (телефон): все пункты меню открываются, «Мой день»/«Карточки» нет', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  const hrefs = await menuHrefs(page, true);
  expect(hrefs).not.toContain('/my-day');
  await page.keyboard.press('Escape');
  await page.goto('/call');
  await walk(page, true, ['/call', '/clients', '/tasks']);
});

test('консультант (телефон): пункты меню открываются', async ({ page }) => {
  const c = await makeConsultant();
  await login(page, { id: c.userId, phone: c.phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/consultations');
  await walk(page, true, ['/consultations', '/tasks']);
});

test('РОП (ноутбук): все пункты боковой колонки открываются, «Пул» и «Карточки» не отдельные пункты', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = `7709${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, 'РОП Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'rop', FALSE, ${t}, ${t})`;
  await login(page, { id, phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/summary');
  const hrefs = await menuHrefs(page, false);
  expect(hrefs).toEqual(expect.arrayContaining(['/summary', '/distribution', '/clients']));
  expect(hrefs).not.toContain('/pool');
  expect(hrefs).not.toContain('/cards');
  await walk(page, false, ['/distribution']);
});


test('глава отдела маркетинга (ноутбук): все пункты открываются, «Отчётов» нет — охват `team` страница не пускает', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = `7709${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, 'Маркетинг Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'marketing_head', FALSE, ${t}, ${t})`;
  await login(page, { id, phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/handoffs');
  const hrefs = await menuHrefs(page, false);
  expect(hrefs).not.toContain('/reports');
  await walk(page, false, ['/handoffs', '/tasks']);
});
