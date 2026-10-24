// Геометрия интерфейса (D-319, критерии приёмки §5): сетка, отступы, места действий на телефоне и ноутбуке.
// Страницы меню каждой роли сида: оператор, консультант, дежурный и директор — телефон; РОП и администратор —
// ноутбук 1440×900. Ветку «Отчёты» без FEATURE_REPORTS (только полная выгрузка) проходит тот же обход РОП, если
// прогон запущен с FEATURE_REPORTS=0. Только синтетика (+7 709 …). БД — E2E_DATABASE_URL. Снимки «после» не
// пишутся: их снимает отдельный прогон.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { expect, test, type Page } from '@playwright/test';
import { DB_URL, PASSWORD, login, makeOperator, OP_BOARD, openCall, prepareDb, sql, type Operator } from './support/calling';
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
  statHoles: string[];
};

/** Все измерения одним проходом в странице: возвращаются числа, проверки — в тесте. */
async function measure(page: Page): Promise<Geo> {
  return page.evaluate(() => {
    const r = (el: Element) => el.getBoundingClientRect();
    const doc = document.documentElement;
    const main = document.querySelector('main.k-page');
    // скрытый заголовок для экранных дикторов (sr-only, как на доске) не часть видимой сетки контента
    const first = main ? ([...main.children].find((c) => !c.classList.contains('sr-only')) ?? null) : null;
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
      // Кнопка внутри карточки: край — левый край содержимого этой карточки (её внутренний отступ), а не страницы
      const host = el.closest('.k-card');
      const edge = host ? r(host).left + parseFloat(getComputedStyle(host).paddingLeft) + parseFloat(getComputedStyle(host).borderLeftWidth) : contentLeft;
      return Math.abs(textLeft - edge) > 1 ? [`${(el.textContent ?? '').trim().slice(0, 30)}: ${Math.round(textLeft)} ≠ ${Math.round(edge)}`] : [];
    });
    // Плитки StatGrid (D-319, D-331): все в одном ряду или в последнем ряду не меньше половины колонок — без дыры
    const statHoles = [...(main?.querySelectorAll('.k-statgrid:not(.k-statgrid--strip)') ?? [])].filter(visible).flatMap((grid) => {
      const tops = [...grid.children].filter(visible).map((c) => Math.round(r(c).top));
      const rows = [...new Set(tops)];
      if (rows.length < 2) return [];
      const cols = tops.filter((t) => t === rows[0]).length;
      const last = tops.filter((t) => t === rows[rows.length - 1]).length;
      return last * 2 >= cols ? [] : [`${(grid.getAttribute('aria-label') ?? grid.textContent ?? '').trim().slice(0, 30)}: ${tops.length} плиток, ряд ${cols}, последний ${last}`];
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
      // «Позвонить» на плитке доски повторяется в каждой плитке по замыслу (одна зелёная кнопка на карточку), главное действие экрана — не она
      primaries: [...document.querySelectorAll('.k-btn--primary')].filter((el) => visible(el) && !inDialog(el) && el.getAttribute('data-testid') !== 'tile-call').length,
      numWrapped: wrapped,
      disabledBad,
      bottomNavTop: nav ? r(nav).top : null,
      lastBottom,
      smallTaps,
      flushBad,
      statHoles,
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
  expect(g.statHoles, w('плитки StatGrid: последний ряд не меньше половины колонок')).toEqual([]);
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

/**
 * Критерий 10: в шапке — org.productName из настроек сида, а не запасная строка локали. Если в настройках
 * theme.brandMark = 'logo' (D-333), вместо текста — логотип: <img alt=productName>, высота 28 px (и в боковом меню ноутбука), без искажения,
 * помещается рядом с колокольчиком.
 */
async function expectBrand(page: Page): Promise<void> {
  const [row] = await sql<{ name: string | null; mark: string | null }[]>`
    SELECT doc->'org'->'productName'->>'ru' AS name, doc->'theme'->>'brandMark' AS mark
    FROM config_revisions WHERE scope = 'global' ORDER BY rev DESC LIMIT 1`;
  expect(row?.name, 'productName в настройках сида').toBeTruthy();
  const brand = page.getByTestId('shell-brand');
  if (row?.mark !== 'logo') {
    await expect(brand).toHaveText(row!.name!.trim());
    return;
  }
  const img = brand.locator('img');
  await expect(img).toHaveAttribute('alt', row!.name!.trim());
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), 'логотип загрузился').toBeGreaterThan(0);
  const m = await img.evaluate((el: HTMLImageElement) => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, nw: el.naturalWidth, nh: el.naturalHeight, right: el.getBoundingClientRect().right }));
  const wantH = 28;
  expect(Math.abs(m.h - wantH), `высота логотипа ${m.h}`).toBeLessThanOrEqual(1);
  const bellLeft = await page.locator('a[aria-label^="Уведомления"]').first().evaluate((el) => el.getBoundingClientRect().left);
  expect(m.right, 'логотип не заходит на колокольчик').toBeLessThanOrEqual(bellLeft);
  expect(Math.abs(m.w / m.h / (m.nw / m.nh) - 1), 'пропорции без искажения').toBeLessThanOrEqual(0.01);
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
  expect(hrefs).toEqual(expect.arrayContaining(OP_BOARD ? ['/board', '/call', '/tasks'] : ['/call', '/clients', '/tasks']));
  for (const href of [...hrefs, '/archive', '/notifications', `/clients/${op.clientIds[0]}`]) await check(page, href, true);
});

test('оператор (ноутбук 1440×900): с OP_BOARD — боковая колонка, левый край 272 ± 1; без флага — нижняя панель', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const op = await makeOperator(2, { lpr: true });
  await login(page, op);
  await page.goto('/call');
  await expectBrand(page);
  if (!OP_BOARD) {
    // без OP_BOARD оператор на ноутбуке остаётся с нижней панелью (поведение прежнее): боковой колонки нет
    await expect(page.locator('aside nav[aria-label="Разделы"]')).toBeHidden();
    return;
  }
  await expect(page.locator('aside nav[aria-label="Разделы"]')).toBeVisible();
  const hrefs = (await menuHrefs(page, false)).filter((h) => h !== '/account');
  expect(hrefs).toEqual(expect.arrayContaining(['/board', '/call', '/tasks']));
  for (const href of [...hrefs, '/archive', '/notifications', `/clients/${op.clientIds[0]}`]) await check(page, href, false);
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

type SegFocus = {
  label: string;
  focusVisible: boolean;
  selected: boolean;
  ringInside: boolean;
  ring: number[];
  group: number[];
  outline: string;
  behind: string;
  border: string;
  clip: string;
};

/** Tab до сегмента с подписью label: только клавиатура, чтобы сработал :focus-visible. */
async function tabToSegment(page: Page, label: string): Promise<SegFocus> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((l) => {
      const a = document.activeElement;
      return !!a?.closest('.k-segmented') && (a.textContent ?? '').trim().startsWith(l);
    }, label);
    if (hit) break;
  }
  return page.evaluate(() => {
    const seg = document.activeElement as HTMLElement;
    const group = seg.closest('.k-segmented') as HTMLElement | null;
    const cs = getComputedStyle(seg);
    const selected = seg.matches("[aria-pressed='true'], [aria-selected='true'], [aria-current='page']");
    // кольцо контура: рамка элемента, раздвинутая на outline-offset + outline-width
    const grow = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth);
    const s = seg.getBoundingClientRect();
    const g = group?.getBoundingClientRect() ?? new DOMRect();
    const ring = [s.left - grow, s.top - grow, s.right + grow, s.bottom + grow];
    const box = [g.left, g.top, g.right, g.bottom];
    const ringInside = !!group && ring[0]! >= box[0]! - 0.5 && ring[1]! >= box[1]! - 0.5 && ring[2]! <= box[2]! + 0.5 && ring[3]! <= box[3]! + 0.5;
    // под кольцом: у выбранного — заливка сегмента, у прочих — фон группы (сегмент прозрачен)
    const behind = selected ? cs.backgroundColor : group ? getComputedStyle(group).backgroundColor : '';
    return {
      label: (seg.textContent ?? '').trim(),
      focusVisible: seg.matches(':focus-visible') && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
      selected,
      ringInside,
      ring: ring.map((v) => Math.round(v)),
      group: box.map((v) => Math.round(v)),
      outline: cs.outlineColor,
      behind,
      border: cs.borderTopColor,
      clip: cs.backgroundClip,
    };
  });
}

/** Контраст двух цветов rgb()/rgba() по WCAG (непрозрачные). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function expectSegFocus(f: SegFocus, where: string): void {
  const w = (m: string) => `${where} «${f.label}»: ${m}`;
  expect(f.focusVisible, w('кольцо фокуса с клавиатуры')).toBe(true);
  expect(f.ringInside, w(`кольцо ${f.ring} внутри группы ${f.group}, не срезано overflow`)).toBe(true);
  expect(contrast(f.outline, f.behind), w(`контраст кольца ${f.outline} к фону ${f.behind}`)).toBeGreaterThanOrEqual(3);
}

test('оператор (телефон): переключатель видов — кольцо фокуса внутри группы и контрастно, выбранный не закрывает рамку, подпись по центру', async ({ page }) => {
  const op = await makeOperator(1);
  await login(page, op);

  await page.goto('/clients');
  await expect(page.locator('main .k-segmented')).toBeVisible();
  const all = await tabToSegment(page, 'Все');
  expect(all.selected, '«Все» выбран по умолчанию').toBe(true);
  expectSegFocus(all, '/clients');
  // выбранный сегмент отступает от рамки группы так же, как невыбранный: его рамка прозрачна
  expect(all.border, 'рамка выбранного сегмента прозрачна').toBe('rgba(0, 0, 0, 0)');
  expect(all.clip, 'заливка выбранного — внутри прозрачной рамки, не под ней').toBe('padding-box');
  const mine = await tabToSegment(page, 'Мои');
  expect(mine.selected).toBe(false);
  expectSegFocus(mine, '/clients');
  const archive = page.locator('.k-segmented > .k-chip', { hasText: 'Архив' });
  await archive.hover();
  expect(await archive.evaluate((el) => getComputedStyle(el).backgroundClip), 'подсветка наведения — внутри рамки').toBe('padding-box');

  // перенесённая подпись: каждая строка по центру сегмента, как у соседей в одну строку
  const lines = await page.locator('.k-segmented > .k-chip').evaluateAll((segs) =>
    segs.flatMap((seg) => {
      const s = seg.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(seg);
      const center = s.left + s.width / 2;
      return [...range.getClientRects()].filter((r) => r.width > 0).map((r) => ({ text: (seg.textContent ?? '').trim(), off: Math.round(Math.abs(r.left + r.width / 2 - center)) }));
    }),
  );
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.off > 2), 'строки подписей по центру сегмента').toEqual([]);

  await page.goto('/tasks');
  await expect(page.locator('main .k-segmented')).toBeVisible();
  const myTasks = await tabToSegment(page, 'Мои');
  expect(myTasks.selected, 'вкладка «Мои» выбрана').toBe(true);
  expectSegFocus(myTasks, '/tasks');
  expect(myTasks.border, 'рамка выбранной вкладки прозрачна').toBe('rgba(0, 0, 0, 0)');
  expect(myTasks.clip, 'заливка выбранной вкладки — внутри прозрачной рамки').toBe('padding-box');
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
  // сводка директора — за FEATURE_REPORTS (меню, D-055): без флага вход на «Отчёты», там только полная выгрузка
  const reportsOn = process.env.FEATURE_REPORTS !== '0';
  await page.goto(reportsOn ? '/director' : '/reports');
  await expectBrand(page);
  const hrefs = (await menuHrefs(page, true)).filter((h) => h !== '/account');
  if (reportsOn) expect(hrefs).toContain('/director');
  else expect(hrefs, 'без отчётов за период: нет сводки директора, есть выгрузка').toEqual(expect.arrayContaining(['/reports']));
  if (!reportsOn) expect(hrefs).not.toContain('/director');
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
