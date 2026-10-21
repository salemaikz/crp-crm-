// Геометрия интерфейса (D-319, критерии приёмки §5): сетка, отступы, места действий на телефоне и ноутбуке.
// Страницы меню каждой роли сида: оператор, консультант, дежурный и директор — телефон; РОП и администратор —
// ноутбук 1440×900. Ветку «Отчёты» без FEATURE_REPORTS (только полная выгрузка) проходит тот же обход РОП, если
// прогон запущен с FEATURE_REPORTS=0. Только синтетика (+7 709 …). БД — E2E_DATABASE_URL. Снимки «после» не
// пишутся: их снимает отдельный прогон.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, openCall, prepareDb, sql, type Operator } from './support/calling';
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
  smallTaps: string[];
  flushBad: string[];
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
        // ячейка с числом: запрет переноса в стиле (внутри могут стоять отдельные строки, например «был в сети»)
        return el.tagName === 'TD' ? getComputedStyle(el).whiteSpace !== 'nowrap' : b.height > lh * 1.6;
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
    // Цели касания (§5, правило кита): кнопки, чипы, сегменты, поля — не ниже 44 px; вне закрытых шторок
    const smallTaps = [...document.querySelectorAll('.k-btn, .k-chip, .k-segmented > *, .k-input, .k-toast__undo')]
      .filter((el) => visible(el) && !inDialog(el))
      .filter((el) => r(el).height < 43.5)
      .map((el) => `${(el.textContent ?? '').trim().slice(0, 30)}: ${Math.round(r(el).height * 10) / 10}`);
    // Тихая кнопка «flush»: её текст стоит на левом крае контента, а не сдвинут внутренним отступом размера
    const contentLeft = first ? r(first).left : 0;
    const flushBad = [...(main?.querySelectorAll('.k-btn--flush') ?? [])].filter(visible).flatMap((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const textLeft = range.getBoundingClientRect().left;
      return Math.abs(textLeft - contentLeft) > 1 ? [`${(el.textContent ?? '').trim().slice(0, 30)}: ${Math.round(textLeft)} ≠ ${Math.round(contentLeft)}`] : [];
    });
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
      smallTaps,
      flushBad,
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
  expect(g.flushBad, w('текст кнопок flush на левом крае контента')).toEqual([]);
  if (mobile) expect(g.smallTaps, w('цели касания ≥ 44 px')).toEqual([]);
  if (g.bottomNavTop !== null) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const after = await measure(page);
    expect(after.lastBottom - 0, w('конец контента выше нижнего меню')).toBeLessThanOrEqual((after.bottomNavTop ?? 1e9) + (await page.evaluate(() => window.scrollY)) + 1);
  }
}

/** Адреса пунктов меню роли: на телефоне — панель и лист «Ещё», на ноутбуке — боковая колонка. */
async function menuHrefs(page: Page, mobile: boolean): Promise<string[]> {
  const more = page.getByRole('button', { name: 'Ещё' });
  if (mobile && (await more.count()) > 0) await more.first().click();
  const scope = mobile ? page.locator('nav[aria-label="Разделы"], [role="dialog"]') : page.locator('nav[aria-label="Разделы"]');
  const all = await scope.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  if (mobile && (await more.count()) > 0) await page.keyboard.press('Escape');
  return [...new Set(all)];
}

/** Критерий 10: в шапке — org.productName из настроек сида, а не запасная строка локали. */
async function expectBrand(page: Page): Promise<void> {
  const [row] = await sql<{ name: string | null }[]>`
    SELECT doc->'org'->'productName'->>'ru' AS name FROM config_revisions WHERE scope = 'global' ORDER BY rev DESC LIMIT 1`;
  expect(row?.name, 'productName в настройках сида').toBeTruthy();
  await expect(page.getByTestId('shell-brand')).toHaveText(row!.name!.trim());
}

async function makeStaff(role: string | null, name: string, isAdmin = false): Promise<Operator> {
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const id = randomUUID();
  const phone = await uniquePhone(sql);
  const t = Date.now();
  await sql`INSERT INTO users (id, phone_digits, name, password_hash, is_admin, created_at) VALUES (${id}, ${phone}, ${name}, ${bcrypt.hashSync(PASSWORD, 4)}, ${isAdmin}, ${t})`;
  if (role) {
    await sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${id}, ${space!.id}, ${role}, FALSE, ${t}, ${t})`;
  }
  return { id, phone, cardIds: [], names: [], clientIds: [] };
}

test('оператор (телефон): сетка всех страниц меню и карточки клиента', async ({ page }) => {
  const op = await makeOperator(2, { lpr: true });
  await login(page, op);
  await page.goto('/call');
  await expectBrand(page);
  const hrefs = (await menuHrefs(page, true)).filter((h) => h !== '/account');
  expect(hrefs).toEqual(expect.arrayContaining(['/call', '/clients', '/tasks']));
  for (const href of [...hrefs, '/archive', '/notifications', `/clients/${op.clientIds[0]}`]) await check(page, href, true);
});

test('оператор (телефон): шторка итога — ЛПР «Да/Нет» не ниже 44 px, тост над нижним меню', async ({ page }) => {
  const op = await makeOperator(2, { lpr: true });
  await openCall(page, op);
  await page.getByTestId('call-button').click();
  await expect(page.getByTestId('outcome-sheet')).toBeVisible();
  for (const id of ['lpr-yes', 'lpr-no']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.height ?? 0, `${id}: высота касания`).toBeGreaterThanOrEqual(44);
  }
  await page.getByTestId('outcome-no_answer').click();
  await expect(page.getByTestId('outcome-sheet')).toBeHidden();
  const toast = page.locator('.k-toast').first();
  await expect(toast).toBeVisible();
  // тост въезжает снизу (k-sheet-in): меряем место, где он стоит, а не кадр анимации
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const geo = await page.evaluate(() => {
    const t = document.querySelector('.k-toast')!.getBoundingClientRect();
    const nav = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0);
    const undo = document.querySelector('.k-toast__undo')?.getBoundingClientRect();
    return { bottom: t.bottom, navTop: nav ? nav.getBoundingClientRect().top : window.innerHeight, undoH: undo?.height ?? 44 };
  });
  expect(geo.bottom, 'тост не перекрыт нижним меню').toBeLessThanOrEqual(geo.navTop);
  expect(geo.undoH, '«Отменить» в тосте: высота касания').toBeGreaterThanOrEqual(44);
});

test('консультант (телефон): сетка страниц меню', async ({ page }) => {
  const c = await makeConsultant();
  await login(page, { id: c.userId, phone: c.phone, cardIds: [], names: [], clientIds: [] });
  await page.goto('/consultations');
  await expectBrand(page);
  const hrefs = (await menuHrefs(page, true)).filter((h) => h !== '/account');
  expect(hrefs).toEqual(expect.arrayContaining(['/consultations', '/tasks']));
  for (const href of [...hrefs, '/notifications']) await check(page, href, true);
});

test('дежурный (телефон): экран дежурства на сетке', async ({ page }) => {
  const op = await makeOperator(0);
  const [space] = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE key = 'sales'`;
  const t = Date.now();
  // мероприятие сегодня (Asia/Almaty, UTC+5): началось час назад, но не раньше начала местных суток
  const localMidnight = Math.floor((t + 5 * 3_600_000) / 86_400_000) * 86_400_000 - 5 * 3_600_000;
  const startsAt = Math.max(t - 3_600_000, localMidnight);
  const stamp = new Date(startsAt + 5 * 3_600_000).toISOString();
  const eventId = randomUUID();
  await sql`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity, status, occurrence_key, touched, created_at, updated_at)
    VALUES (${eventId}, ${space!.id}, NULL, 'br', ${stamp.slice(0, 10)}, ${stamp.slice(11, 16)}, ${startsAt}, 180, 'Зал 1', 'offline', 30, 'scheduled', NULL, FALSE, ${t}, ${t})`;
  await sql`INSERT INTO event_duty (event_id, user_id, created_by, created_at) VALUES (${eventId}, ${op.id}, NULL, ${t})`;
  await login(page, op);
  await check(page, `/duty/${eventId}`, true);
});

test('директор (телефон): сетка страниц меню', async ({ page }) => {
  const d = await makeStaff('director', 'Директор Синтетик');
  await login(page, d);
  await page.goto('/director');
  await expectBrand(page);
  const hrefs = (await menuHrefs(page, true)).filter((h) => h !== '/account');
  expect(hrefs).toContain('/director');
  for (const href of [...hrefs, '/notifications']) await check(page, href, true);
});

test('РОП (ноутбук 1440×900): заголовок любой страницы на одной вертикали, группы и аккаунт внизу колонки', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rop = await makeStaff('rop', 'РОП Синтетик');
  await login(page, rop);
  await page.goto('/summary');
  const nav = page.locator('nav[aria-label="Разделы"]');
  const hrefs = await menuHrefs(page, false);
  // боковая колонка: группы с подписями, аккаунт и выход внизу, название из настроек
  await expect(nav.getByRole('group').first()).toBeVisible();
  await expectBrand(page);
  const side = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    const account = [...document.querySelectorAll('aside a')].find((a) => a.getAttribute('href') === '/account');
    const logout = document.querySelector('[data-testid="logout"]');
    const r = (e: Element | null | undefined) => e?.getBoundingClientRect();
    return { asideBottom: r(aside)?.bottom ?? 0, accountTop: r(account)?.top ?? 0, logoutBottom: r(logout)?.bottom ?? 0, h: window.innerHeight };
  });
  expect(side.logoutBottom).toBeGreaterThan(side.h - 80);
  expect(side.accountTop).toBeGreaterThan(side.h / 2);
  // «Отчёты» и «Настройки» — в любом значении флагов: без FEATURE_REPORTS это экран полной выгрузки (D-055)
  expect(hrefs).toEqual(expect.arrayContaining(['/reports', '/settings']));
  for (const href of [...hrefs, '/bookings/events', '/notifications']) await check(page, href, false);
  if (process.env.FEATURE_REPORTS === '0') {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Выгрузка данных', level: 1 }), 'ветка без отчётов за период').toBeVisible();
  }
});

test('администратор без роли (ноутбук 1440×900): сетка страниц меню', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await makeStaff(null, 'Администратор Синтетик', true);
  await login(page, admin);
  await page.goto('/team');
  await expectBrand(page);
  const hrefs = await menuHrefs(page, false);
  expect(hrefs).toContain('/team');
  for (const href of hrefs) await check(page, href, false);
});

test('РОП (ноутбук 1440×900): узкое поле настроек сужает контрол, а не подпись и подсказку; раздача — промежутки и ссылка на пары в шапке', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rop = await makeStaff('rop', 'РОП Синтетик');
  await login(page, rop);

  await page.goto('/settings');
  const cap = page.getByLabel('Лимит карточек на оператора в день');
  await expect(cap).toBeVisible();
  const f = await cap.evaluate((input) => {
    const field = input.closest('.k-field')!;
    const lh = (el: Element) => parseFloat(getComputedStyle(el).lineHeight) || 20;
    const label = field.querySelector('.k-field__label')!;
    const hint = field.querySelector('.k-field__hint')!;
    return {
      input: input.getBoundingClientRect().width,
      labelLines: Math.round(label.getBoundingClientRect().height / lh(label)),
      hintLines: Math.round(hint.getBoundingClientRect().height / lh(hint)),
    };
  });
  expect(f.input, 'поле числа — ширины --field-w-xs').toBeLessThanOrEqual(121);
  expect(f.labelLines, 'подпись в одну строку').toBe(1);
  expect(f.hintLines, 'подсказка не сжата в столбик').toBeLessThanOrEqual(2);

  await page.goto('/distribution');
  await expect(page.locator('.k-page-header__actions a[href="/pairs"]'), 'ссылка на пары — в действиях шапки').toBeVisible();
  const issue = page.getByRole('button', { name: 'Раздать выбранные' });
  await expect(issue).toBeVisible();
  const gap = await issue.evaluate((btn) => {
    const tiles = btn.closest('[role="tabpanel"]')!.querySelector('.k-statgrid')!;
    return btn.getBoundingClientRect().top - tiles.getBoundingClientRect().bottom;
  });
  expect(gap, 'строка «Раздать выбранные» отступает от плиток на --space-stack').toBeGreaterThanOrEqual(11);
});
