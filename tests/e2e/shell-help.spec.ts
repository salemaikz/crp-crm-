// Справка «Как работать» и подсказка первого входа на доску (pv2-polish S3, S4). Идёт с FEATURE_OP_BOARD=1 на обоих пресетах:
// по умолчанию слои ЦРП, с ISOLATION_PRESET=base — базовый (свой БД прогона). Подписи колонок ожидаем из активных настроек.
// Только синтетика (+7 709 …). БД — E2E_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, OP_BOARD, PASSWORD, login, makeOperator, prepareDb, sql } from './support/calling';
import { makeConsultant } from './support/consult';
import { uniquePhone } from './support/phones';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.skip(!OP_BOARD, 'справка и подсказка — за флагом OP_BOARD');
test.beforeAll(() => prepareDb());

const BASE = process.env.ISOLATION_PRESET === 'base';
const OPERATOR_ROLE = BASE ? 'manager' : 'operator';
const ROP_ROLE = BASE ? 'lead' : 'rop';

type SpaceDoc = {
  board?: { columns: { key: string; label: { ru: string }; states: string[] }[]; tones?: { when: string; tone: string }[] };
  booking?: { eventTypes?: { behavior: string; label: { ru: string }; short?: { ru: string } }[] };
};

/** Активные настройки пространства продаж: то, из чего справка берёт подписи. */
async function spaceDoc(): Promise<SpaceDoc> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const [row] = await sql<{ doc: SpaceDoc }[]>`SELECT doc FROM config_revisions WHERE scope = ${space!.id} ORDER BY rev DESC LIMIT 1`;
  return row!.doc;
}

async function staff(role: string): Promise<{ id: string; phone: string; cardIds: string[]; names: string[]; clientIds: string[] }> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = await uniquePhone(sql);
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, 'Руководитель Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, ${role}, FALSE, ${t}, ${t})`;
  return { id, phone, cardIds: [], names: [], clientIds: [] };
}

const ANCHORS = ['board', 'move', 'trash', 'callback', 'attend', 'purchases'];

async function expectBoardSections(page: Page): Promise<void> {
  for (const a of ANCHORS) await expect(page.locator(`main section#${a}`), `раздел #${a}`).toBeVisible();
  // подписи колонок из настроек (на пресете без доски — подписи состояний, но не пусто)
  const doc = await spaceDoc();
  const board = page.locator('main section#board');
  if (doc.board) {
    for (const c of doc.board.columns) await expect(board, `колонка «${c.label.ru}»`).toContainText(c.label.ru);
  } else {
    await expect(board).toContainText(/Колонки — этапы работы с ним: .+\./);
  }
  // легенда: огоньки и сортировка
  await expect(board).toContainText('Оранжевый огонёк');
  await expect(board).toContainText('Красный огонёк');
  await expect(board).toContainText('По горячести');
  // тон плитки — по тону набора и названию вида из настроек
  for (const [when, behavior] of [['attendedGroup', 'group'], ['attendedIndividual', 'individual']] as const) {
    const tone = doc.board?.tones?.find((t) => t.when === when)?.tone;
    const ev = doc.booking?.eventTypes?.find((e) => e.behavior === behavior);
    if (!tone || !ev) continue;
    const word = ({ success: 'Зелёная', warning: 'Жёлтая', danger: 'Красная', info: 'Синяя', neutral: 'Серая', brand: 'Фирменная' } as Record<string, string>)[tone];
    await expect(board).toContainText(`${word} плитка — клиент уже был на мероприятии «${ev.short?.ru ?? ev.label.ru}»`);
  }
  const move = page.locator('main section#move');
  await expect(move).toContainText('Удерживайте плитку');
  await expect(move).toContainText('Перенести в…');
}

test('оператор (телефон): «Как работать» открывается из «Ещё», разделы доски с подписями из настроек', async ({ page }) => {
  const op = await makeOperator(1, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/call');
  await page.getByRole('button', { name: 'Ещё' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Как работать' }).click();
  await page.waitForURL('**/help');
  await expect(page.getByRole('heading', { level: 1, name: 'Как работать' })).toBeVisible();
  await expectBoardSections(page);
  const bad = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(bad, 'горизонтальная прокрутка').toBe(false);
});

test('оператор: якорь /help#move прокручивает к разделу', async ({ page }) => {
  const op = await makeOperator(1, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/help#move');
  await expect(page.locator('main section#move')).toBeInViewport();
});

test('оператор (ноутбук 1440): справка рядом с боковым меню, левый край контента 272', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const op = await makeOperator(1, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/help');
  await expect(page.locator('nav[aria-label="Разделы"] a[aria-current="page"]')).toHaveText('Как работать');
  const left = await page.locator('main.k-page > header').evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(left - 272)).toBeLessThanOrEqual(1);
  await expectBoardSections(page);
});

test('руководитель (ноутбук): справка с доской РОП, пункт «Как работать» в боковом меню', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const rop = await staff(ROP_ROLE);
  await login(page, rop);
  await page.goto('/summary');
  await page.locator('nav[aria-label="Разделы"]').getByRole('link', { name: 'Как работать' }).click();
  await page.waitForURL('**/help');
  await expect(page.locator('main section#board')).toContainText('Доска показывает клиентов всех сотрудников');
  for (const a of ANCHORS) await expect(page.locator(`main section#${a}`)).toBeVisible();
});

test('консультант (телефон): свои разделы справки, доски нет', async ({ page }) => {
  test.skip(BASE, 'в базовом пресете нет роли консультанта');
  const c = await makeConsultant();
  await login(page, { id: c.userId, phone: c.phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/help');
  await expect(page.locator('main section#consultations')).toBeVisible();
  await expect(page.locator('main section#tasks')).toBeVisible();
  await expect(page.locator('main section#board')).toHaveCount(0);
});

test('подсказка первого входа на доске: показ, «Понятно», повторно не показывается', async ({ page }) => {
  const op = await makeOperator(2, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/call');
  await expect(page.getByTestId('board-tip'), 'вне доски подсказки нет').toHaveCount(0);
  await page.goto('/board');
  const tip = page.getByTestId('board-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Удерживайте плитку, чтобы перенести.');
  // над нижним меню и не закрывает вкладки колонок
  const geo = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="board-tip"]')!.getBoundingClientRect();
    const nav = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0)!.getBoundingClientRect();
    const tabs = document.querySelector('[role="tablist"]')?.getBoundingClientRect();
    return { tipBottom: t.bottom, tipTop: t.top, navTop: nav.top, tabsBottom: tabs?.bottom ?? 0, left: t.left, right: t.right, w: window.innerWidth };
  });
  expect(geo.tipBottom, 'подсказка над нижним меню').toBeLessThanOrEqual(geo.navTop);
  expect(geo.tipTop, 'вкладки не закрыты').toBeGreaterThan(geo.tabsBottom);
  expect(geo.left, 'не обрезана слева').toBeGreaterThanOrEqual(0);
  expect(geo.right, 'не обрезана справа').toBeLessThanOrEqual(geo.w);
  await page.reload();
  await expect(tip, 'без «Понятно» остаётся').toBeVisible();
  await page.getByTestId('board-tip-ok').click();
  await expect(tip).toBeHidden();
  expect(await page.evaluate((k) => window.localStorage.getItem(k), `crm.tip.board.v1:${op.id}`)).toBe('1');
  await page.reload();
  await expect(page.getByTestId('board-screen'), 'доска на месте').toBeVisible();
  await expect(tip).toHaveCount(0);
});

test('подсказка: ссылка ведёт на /help#board и тоже закрывает подсказку', async ({ page }) => {
  const op = await makeOperator(1, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/board');
  await page.getByTestId('board-tip').getByRole('link').click();
  await page.waitForURL('**/help#board');
  await expect(page.locator('main section#board')).toBeVisible();
  await page.goto('/board');
  await expect(page.getByTestId('board-tip')).toHaveCount(0);
});

test('подсказка принимает касания целиком: касание текста не доходит до «Позвонить» под ней, последняя плитка не закрыта', async ({ page }) => {
  const op = await makeOperator(3, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/board');
  const tip = page.getByTestId('board-tip');
  await expect(tip).toBeVisible();
  await expect(page.getByTestId('tile-call').first()).toBeVisible();
  // в центре текста подсказки — сама подсказка, а не плитка под ней
  const box = (await tip.locator('p').boundingBox())!;
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="board-tip"]') !== null, { x: box.x + 20, y: box.y + box.height / 2 });
  expect(hit, 'под пальцем подсказка').toBe(true);
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await expect(page.getByTestId('outcome-sheet'), 'шторка итога не открылась').toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.includes('pending'))), 'намерения звонка нет').toEqual([]);
  // нижний отступ области страницы: прокрутив вниз, последняя кнопка «Позвонить» оказывается выше подсказки
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const geo = await page.evaluate(() => {
    const calls = [...document.querySelectorAll('[data-testid="tile-call"]')];
    const tipTop = document.querySelector('[data-testid="board-tip"]')!.getBoundingClientRect().top;
    return { lastBottom: Math.max(...calls.map((c) => c.getBoundingClientRect().bottom)), tipTop };
  });
  expect(geo.lastBottom, 'последняя плитка не под подсказкой').toBeLessThanOrEqual(geo.tipTop);
});

test('подсказка на ноутбуке 1440: спейсер не добавляет вертикальной прокрутки документа, плашка в правом нижнем углу', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const op = await makeOperator(4, { role: OPERATOR_ROLE });
  await login(page, op);
  await page.goto('/board');
  const tip = page.getByTestId('board-tip');
  await expect(tip).toBeVisible();
  await expect(page.getByTestId('board-tip-spacer')).toBeHidden();
  const box = (await tip.boundingBox())!;
  expect(box.x + box.width, 'у правого края окна').toBeGreaterThan(1440 - 40);
  expect(box.width).toBeLessThanOrEqual(384);
});

test('К5: на флагах стенда доска обзвона РОП открывается (200)', async ({ page }) => {
  const rop = await staff(ROP_ROLE);
  await login(page, rop);
  const res = await page.goto('/deals/calling');
  expect(res?.status()).toBe(200);
});
