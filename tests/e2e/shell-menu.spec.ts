// Обход меню по ролям (D-313): каждый пункт нижней панели, «Ещё» и боковой колонки открывается без 404.
// Оператор и консультант — телефон, РОП — ноутбук. Только синтетика (+7 709 …). БД — E2E_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql } from './support/calling';
import { makeConsultant } from './support/consult';
import { uniquePhone } from './support/phones';

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

// Доска оператора (U1) за флагом OP_BOARD: при флаге в меню есть /board и нет /clients, без флага — как раньше
const BOARD = process.env.FEATURE_OP_BOARD === '1';

test('оператор (телефон): все пункты меню открываются, «Мой день»/«Карточки» нет', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  const hrefs = await menuHrefs(page, true);
  expect(hrefs).not.toContain('/my-day');
  if (BOARD) {
    expect(hrefs, 'при OP_BOARD «Клиентов» нет: их заменяет поиск над доской').not.toContain('/clients');
    expect(hrefs[0], 'Доска первая').toBe('/board');
  } else {
    expect(hrefs, 'без OP_BOARD доски нет').not.toContain('/board');
  }
  await page.keyboard.press('Escape');
  await page.goto('/call');
  await walk(page, true, BOARD ? ['/board', '/call', '/tasks'] : ['/call', '/clients', '/tasks']);
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
  const phone = await uniquePhone(sql);
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
  const phone = await uniquePhone(sql);
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, 'Маркетинг Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'marketing_head', FALSE, ${t}, ${t})`;
  await login(page, { id, phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/handoffs');
  const hrefs = await menuHrefs(page, false);
  expect(hrefs).not.toContain('/reports');
  await walk(page, false, ['/handoffs', '/tasks']);
});

// Оболочка оператора (S1, ui-polish §9.8): на ≥ 768 px боковая колонка со всеми пунктами, без нижней панели и «Ещё»;
// на телефоне нижнее меню. Нижняя панель — fixed-nav; боковая — nav внутри aside.
async function bottomBarVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => [...document.querySelectorAll('nav')].some((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0));
}

test('оператор (ноутбук 1280): боковое меню со всеми пунктами, нижней панели и «Ещё» нет', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  const side = page.locator('aside nav[aria-label="Разделы"]');
  await expect(side).toBeVisible();
  expect(await bottomBarVisible(page), 'нижней панели нет').toBe(false);
  await expect(page.getByRole('button', { name: 'Ещё' }), 'кнопки «Ещё» нет').toBeHidden();
  const hrefs = await side.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(hrefs).toEqual(expect.arrayContaining(BOARD ? ['/board', '/call', '/tasks', '/bookings', '/archive'] : ['/call', '/clients', '/tasks', '/bookings', '/archive']));
  // аккаунт и выход — внизу колонки
  await expect(page.locator('aside').getByRole('link', { name: 'Мой аккаунт' })).toBeVisible();
  await expect(page.locator('aside').getByTestId('logout')).toBeVisible();
});

test('оператор (Pixel 7): нижняя панель с «Ещё», боковой колонки нет', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  expect(await bottomBarVisible(page), 'нижняя панель есть').toBe(true);
  await expect(page.getByRole('button', { name: 'Ещё' })).toBeVisible();
  await expect(page.locator('aside nav[aria-label="Разделы"]'), 'боковая колонка скрыта').toBeHidden();
});

test('оператор: «Мои покупки» и «Как работать» — в боковом меню на ноутбуке и в «Ещё» на телефоне', async ({ page }) => {
  test.skip(!BOARD, 'пункты за флагом OP_BOARD');
  const op = await makeOperator(1);
  await login(page, op);
  await page.goto('/call');
  // телефон: в нижней панели Доска / Звонить / Задачи, остальное в «Ещё»
  const bar = page.locator('nav[aria-label="Разделы"]').last();
  const barHrefs = await bar.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(barHrefs).toEqual(['/board', '/call', '/tasks']);
  await page.getByRole('button', { name: 'Ещё' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('link', { name: 'Мои покупки' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Как работать' })).toBeVisible();
  await page.keyboard.press('Escape');
  await walk(page, true, ['/board/purchases', '/help']);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/call');
  const side = page.locator('aside nav[aria-label="Разделы"]');
  await expect(side.getByRole('link', { name: 'Мои покупки' })).toBeVisible();
  await expect(side.getByRole('link', { name: 'Как работать' })).toBeVisible();
});

test('РОП (ноутбук): «Доска» ведёт на /deals/calling в группе «Работа», «Как работать» есть; у роли с охватом own доски нет', async ({ page }) => {
  test.skip(!BOARD, 'пункты за флагом OP_BOARD');
  await page.setViewportSize({ width: 1280, height: 800 });
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const make = async (role: string) => {
    const id = randomUUID();
    const phone = await uniquePhone(sql);
    const t = Date.now();
    await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, 'Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
    await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, ${role}, FALSE, ${t}, ${t})`;
    return { id, phone, cardIds: [], names: [], clientIds: [] };
  };
  await login(page, await make('rop'));
  await page.goto('/summary');
  const work = page.locator('aside nav[aria-label="Разделы"] [role="group"][aria-label="Работа"]');
  await expect(work.getByRole('link', { name: 'Доска' })).toHaveAttribute('href', '/deals/calling');
  await expect(page.locator('aside nav[aria-label="Разделы"]').getByRole('link', { name: 'Как работать' })).toHaveAttribute('href', '/help');
  await walk(page, false, ['/deals/calling', '/help']);
  // «Доска» подсвечена на своей странице, «Сделки» — нет
  await page.goto('/deals/calling');
  await expect(page.locator('aside nav a[aria-current="page"]')).toHaveText('Доска');
  await page.context().clearCookies();
  // консультант: охват карточек own — пункта «Доска» нет, справка есть
  const c = await makeConsultant();
  await login(page, { id: c.userId, phone: c.phone, cardIds: [], names: [], clientIds: [] });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/consultations');
  const hrefs = await menuHrefs(page, true);
  expect(hrefs).not.toContain('/deals/calling');
  expect(hrefs).toContain('/help');
});
