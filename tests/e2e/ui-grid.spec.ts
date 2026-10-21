// Геометрия интерфейса (D-319, критерии приёмки §5): сетка, отступы, места действий на телефоне и ноутбуке.
// Страницы меню каждой роли сида: оператор и консультант — телефон, РОП — ноутбук 1440×900. Только синтетика
// (+7 709 …). БД — E2E_DATABASE_URL. Снимки «после» не пишутся: их снимает отдельный прогон.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, prepareDb, sql } from './support/calling';
import { makeConsultant } from './support/consult';
import { uniquePhone } from './support/phones';

test.skip(!DB_URL, 'E2E_DATABASE_URL не задан');
test.beforeAll(() => prepareDb());

const SIDE_X = 272; // 240 (колонка) + 32 (--gutter от 1280)

type Geo = {
  scrollOk: boolean;
  firstLeft: number | null;
  firstRight: number | null;
  width: number;
  header: { brandLeft: number | null; bellRight: number | null };
  actions: { right: number; midY: number; h1MidY: number; sameRow: boolean } | null;
  equalBars: number[][];
  primaries: number;
  numWrapped: string[];
  disabledBad: string[];
  bottomNavTop: number | null;
  lastBottom: number;
};

/** Все измерения одним проходом в странице: возвращаются числа, проверки — в тесте. */
async function measure(page: Page): Promise<Geo> {
  return page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const doc = document.documentElement;
    const main = document.querySelector('main.k-page');
    const first = main?.firstElementChild ?? null;
    const brand = document.querySelector('[data-testid="shell-brand"]');
    const bell = document.querySelector('a[aria-label^="Уведомления"] svg');
    const acts = main?.querySelector('.k-page-header__actions') ?? null;
    const h1 = main?.querySelector('h1') ?? null;
    let actions: Geo['actions'] = null;
    const lastShown = acts ? [...acts.children].reverse().find((c) => r(c).width > 0 && r(c).height > 0) : undefined;
    if (acts && h1 && lastShown) {
      const a = r(acts);
      const l = r(lastShown);
      const t = r(h1);
      actions = { right: l.right, midY: a.top + a.height / 2, h1MidY: t.top + t.height / 2, sameRow: a.top < t.bottom - 2 };
    }
    const nav = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0);
    const visible = (el: Element) => {
      const b = r(el);
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const inDialog = (el: Element) => !!el.closest('dialog');
    const bars = [...document.querySelectorAll('.k-actionbar--equal')].filter(visible).map((b) => [...b.children].filter(visible).map((c) => Math.round(r(c).width * 10) / 10));
    const wrapped = [...document.querySelectorAll('.k-num, td[data-numeric]')]
      .filter(visible)
      .filter((el) => {
        const b = r(el);
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        return el.tagName === 'TD' ? b.height > lh * 2.6 : b.height > lh * 1.6;
      })
      .map((el) => (el.textContent ?? '').trim().slice(0, 30));
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
    const probe = document.createElement('i');
    probe.style.color = canvas;
    document.body.appendChild(probe);
    const canvasRgb = getComputedStyle(probe).color;
    probe.remove();
    const disabledBad = [...document.querySelectorAll('.k-btn:disabled')]
      .filter(visible)
      .filter((el) => getComputedStyle(el).opacity !== '1' || getComputedStyle(el).backgroundColor !== canvasRgb)
      .map((el) => (el.textContent ?? '').trim().slice(0, 30));
    const content = main ? [...main.querySelectorAll('*')].filter(visible) : [];
    const lastBottom = content.reduce((m, el) => Math.max(m, r(el).bottom + window.scrollY), 0);
    return {
      scrollOk: doc.scrollWidth <= doc.clientWidth,
      firstLeft: first ? r(first).left : null,
      firstRight: first ? r(first).right : null,
      width: doc.clientWidth,
      header: { brandLeft: brand ? r(brand).left : null, bellRight: bell ? r(bell).right : null },
      actions,
      equalBars: bars,
      primaries: [...document.querySelectorAll('.k-btn--primary')].filter((el) => visible(el) && !inDialog(el)).length,
      numWrapped: wrapped,
      disabledBad,
      bottomNavTop: nav ? r(nav).top : null,
      lastBottom,
    };
  });
}

async function check(page: Page, href: string, mobile: boolean): Promise<void> {
  const res = await page.goto(href);
  expect(res?.status() ?? 0, `${href}: статус`).toBeLessThan(400);
  await expect(page.locator('main.k-page h1, main.k-page h2').first(), `${href}: заголовок`).toBeVisible();
  await page.waitForTimeout(400);
  const g = await measure(page);
  // Снимки «после» — по запросу и вне репозитория: UI_SHOTS=<каталог>
  if (process.env.UI_SHOTS) await page.screenshot({ path: `${process.env.UI_SHOTS}/${mobile ? 'm' : 'l'}${href.replace(/[^a-z0-9]+/gi, '-')}.png` });
  const w = (m: string) => `${href}: ${m}`;
  expect(g.scrollOk, w('горизонтальная прокрутка документа')).toBe(true);
  if (mobile) {
    expect(g.firstLeft ?? 0, w('левый край контента')).toBeGreaterThanOrEqual(15);
    expect(g.firstLeft ?? 0, w('левый край контента')).toBeLessThanOrEqual(17);
    expect(Math.abs((g.firstRight ?? 0) - (g.width - 16)), w('правый край контента')).toBeLessThanOrEqual(1);
    expect(Math.abs((g.header.brandLeft ?? 16) - 16), w('название в шапке на линии --gutter')).toBeLessThanOrEqual(1);
    expect(Math.abs((g.header.bellRight ?? g.width - 16) - (g.width - 16)), w('колокольчик на линии --gutter')).toBeLessThanOrEqual(1);
  } else {
    expect(Math.abs((g.firstLeft ?? SIDE_X) - SIDE_X), w('левый край контента')).toBeLessThanOrEqual(1);
  }
  if (g.actions && g.actions.sameRow) {
    expect(Math.abs(g.actions.right - ((g.firstRight ?? 0) - 0)), w('правый край действий шапки')).toBeLessThanOrEqual(1.5);
    expect(Math.abs(g.actions.midY - g.actions.h1MidY), w('действия по центру h1')).toBeLessThanOrEqual(8);
  }
  for (const bar of g.equalBars) {
    expect(Math.max(...bar) - Math.min(...bar), w(`кнопки ActionBar equal: ${bar.join('/')}`)).toBeLessThanOrEqual(1);
  }
  expect(g.primaries, w('видимых primary вне шторки')).toBeLessThanOrEqual(1);
  expect(g.numWrapped, w('перенос чисел и телефонов')).toEqual([]);
  expect(g.disabledBad, w('неактивные кнопки: фон canvas, без opacity')).toEqual([]);
  if (g.bottomNavTop !== null) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const after = await measure(page);
    expect(after.lastBottom - 0, w('конец контента выше нижнего меню')).toBeLessThanOrEqual((after.bottomNavTop ?? 1e9) + (await page.evaluate(() => window.scrollY)) + 1);
  }
}

test('оператор (телефон): сетка всех страниц меню', async ({ page }) => {
  const op = await makeOperator(2, { lpr: true });
  await login(page, op);
  for (const href of ['/call', '/clients', '/tasks', '/bookings', '/archive', '/notifications', `/clients/${op.clientIds[0]}`]) {
    await check(page, href, true);
  }
});

test('консультант (телефон): сетка страниц меню', async ({ page }) => {
  const c = await makeConsultant();
  await login(page, { id: c.userId, phone: c.phone, cardIds: [], names: [], clientIds: [] });
  for (const href of ['/consultations', '/tasks', '/notifications']) await check(page, href, true);
});

test('РОП (ноутбук 1440×900): заголовок любой страницы на одной вертикали, группы и аккаунт внизу колонки', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = await uniquePhone(sql);
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, created_at) VALUES (${id}, ${phone}, 'РОП Синтетик', ${bcrypt.hashSync(PASSWORD, 4)}, ${t})`;
  await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, 'rop', FALSE, ${t}, ${t})`;
  await login(page, { id, phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/summary');
  const nav = page.locator('nav[aria-label="Разделы"]');
  const hrefs = [...new Set(await nav.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')))];
  // боковая колонка: группы с подписями, аккаунт и выход внизу, название из настроек
  await expect(nav.getByRole('group').first()).toBeVisible();
  await expect(page.getByTestId('shell-brand')).not.toHaveText('');
  const side = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    const account = [...document.querySelectorAll('aside a')].find((a) => a.getAttribute('href') === '/account');
    const logout = document.querySelector('[data-testid="logout"]');
    const r = (e: Element | null | undefined) => e?.getBoundingClientRect();
    return { asideBottom: r(aside)?.bottom ?? 0, accountTop: r(account)?.top ?? 0, logoutBottom: r(logout)?.bottom ?? 0, h: window.innerHeight };
  });
  expect(side.logoutBottom).toBeGreaterThan(side.h - 80);
  expect(side.accountTop).toBeGreaterThan(side.h / 2);
  for (const href of [...hrefs, '/bookings/events', '/notifications']) await check(page, href, false);
});
